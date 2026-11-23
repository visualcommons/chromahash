using System.Text.Json;
using ChromaHash;
using CH = ChromaHash.ChromaHash;

// The C# library is now a thin P/Invoke wrapper over the chromahash-c C ABI, so
// these tests exercise the public API end-to-end against the shared spec vectors —
// the cross-language parity gate. Per-function unit tests of the algorithm live in
// the Rust core (the single source of truth).

static class Helpers
{
    public static readonly string SpecVectors = Path.Combine(
        AppContext.BaseDirectory,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "spec",
        "test-vectors"
    );

    public static byte[] SolidImage(int w, int h, byte r, byte g, byte b, byte a)
    {
        byte[] rgba = new byte[w * h * 4];
        for (int i = 0; i < w * h; i++)
        {
            rgba[i * 4] = r;
            rgba[i * 4 + 1] = g;
            rgba[i * 4 + 2] = b;
            rgba[i * 4 + 3] = a;
        }
        return rgba;
    }

    public static byte[] HorizontalGradient(int w, int h)
    {
        byte[] rgba = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                double t = (double)x / Math.Max(w - 1, 1);
                int idx = (y * w + x) * 4;
                rgba[idx] = (byte)(t * 255);
                rgba[idx + 1] = (byte)((1.0 - t) * 255);
                rgba[idx + 2] = 128;
                rgba[idx + 3] = 255;
            }
        }
        return rgba;
    }

    public static byte[] VerticalGradient(int w, int h)
    {
        byte[] rgba = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            double t = (double)y / Math.Max(h - 1, 1);
            for (int x = 0; x < w; x++)
            {
                int idx = (y * w + x) * 4;
                rgba[idx] = (byte)(t * 255);
                rgba[idx + 1] = (byte)(t * 128);
                rgba[idx + 2] = (byte)((1.0 - t) * 255);
                rgba[idx + 3] = 255;
            }
        }
        return rgba;
    }

    public static Gamut GamutFromString(string s) =>
        s switch
        {
            "sRGB" => Gamut.Srgb,
            "Display P3" => Gamut.DisplayP3,
            "Adobe RGB" => Gamut.AdobeRgb,
            "BT.2020" => Gamut.Bt2020,
            "ProPhoto RGB" => Gamut.ProPhotoRgb,
            // Not a fallback to sRGB: that would report a hash mismatch for an
            // unrecognised gamut instead of naming the real cause.
            _ => throw new ArgumentException($"unknown gamut in spec vector: {s}"),
        };
}

// ── ChromaHash public-API behaviour ─────────────────────────────────────────────

public class ChromaHashTests
{
    [Fact]
    public void EncodeProduces32Bytes()
    {
        CH hash = CH.Encode(4, 4, Helpers.SolidImage(4, 4, 128, 128, 128, 255), Gamut.Srgb);
        Assert.Equal(32, hash.AsBytes().Length);
    }

    /// <summary>
    /// The byte length is a function of the tier alone, so assert all five —
    /// the table spec §3.3 tabulates. Asserting only the default would pass
    /// even if every higher tier collapsed to the same size.
    /// </summary>
    [Theory]
    [InlineData(CH.CompactTier, 21)]
    [InlineData(CH.DefaultTier, 32)]
    [InlineData((byte)2, 108)]
    [InlineData((byte)3, 411)]
    [InlineData(CH.MaxTier, 1623)]
    public void EachTierEncodesToItsDocumentedLength(byte tier, int expected)
    {
        byte[] rgba = Helpers.SolidImage(4, 4, 128, 128, 128, 255);
        Assert.Equal(expected, CH.EncodeWithQuality(4, 4, rgba, Gamut.Srgb, tier).AsBytes().Length);
    }

    /// <summary>
    /// Decoded dimensions come from the aspect byte and the tier's raster. A
    /// range check wide enough to pass at every tier cannot tell them apart,
    /// so assert the values.
    /// </summary>
    [Theory]
    [InlineData(CH.CompactTier, 32u)]
    [InlineData(CH.DefaultTier, 32u)]
    [InlineData((byte)2, 64u)]
    [InlineData((byte)3, 128u)]
    [InlineData(CH.MaxTier, 256u)]
    public void DecodedDimensionsFollowTheTierRaster(byte tier, uint edge)
    {
        byte[] rgba = Helpers.SolidImage(4, 4, 128, 64, 32, 255);
        var (w, h, pixels) = CH.EncodeWithQuality(4, 4, rgba, Gamut.Srgb, tier).Decode();
        Assert.Equal(edge, w);
        Assert.Equal(edge, h);
        Assert.Equal((int)(w * h * 4), pixels.Length);
    }

    [Fact]
    public void FromBytesRoundtrip()
    {
        CH hash = CH.Encode(4, 4, Helpers.SolidImage(4, 4, 128, 64, 32, 255), Gamut.Srgb);
        Assert.Equal(hash, CH.FromBytes(hash.AsBytes()));
    }

    /// <summary>
    /// The header is self-describing, so a length that disagrees with it is
    /// rejected at construction, not at first use.
    /// </summary>
    [Fact]
    public void FromBytesRejectsWrongLength()
    {
        byte[] valid = CH.Encode(4, 4, Helpers.SolidImage(4, 4, 128, 64, 32, 255), Gamut.Srgb).AsBytes();

        Assert.Throws<ArgumentException>(() => CH.FromBytes(valid[..^1]));
        Assert.Throws<ArgumentException>(() => CH.FromBytes([.. valid, (byte)0]));
        Assert.Throws<ArgumentException>(() => CH.FromBytes([]));
    }

    /// <summary>
    /// The reserved bit is how v1 reserves room for a future extension: a
    /// decoder that ignored it would accept a hash written by a later format
    /// and render garbage.
    /// </summary>
    [Theory]
    [InlineData("reserved bit set", 0b1000_0000, 0)]
    [InlineData("reserved tier code", 0, (CH.MaxTier + 1) << 3)]
    [InlineData("unsupported version", 0b0000_0010, 0)]
    public void FromBytesRejectsAMalformedHeader(string what, int orMask, int tierBits)
    {
        byte[] bytes = CH.Encode(4, 4, Helpers.SolidImage(4, 4, 1, 2, 3, 255), Gamut.Srgb).AsBytes();
        int b0 = bytes[0] | orMask;
        if (tierBits != 0)
            b0 = (b0 & ~0b0011_1000) | tierBits;
        bytes[0] = (byte)b0;

        var ex = Assert.Throws<ArgumentException>(() => CH.FromBytes(bytes));
        Assert.NotNull(ex);
        Assert.NotEmpty(what);
    }

    [Theory]
    [InlineData(0u, 4u)]
    [InlineData(4u, 0u)]
    public void InvalidDimensionsThrow(uint w, uint h)
    {
        byte[] rgba = Helpers.SolidImage(4, 4, 128, 128, 128, 255);
        Assert.Throws<ArgumentOutOfRangeException>(() => CH.Encode(w, h, rgba, Gamut.Srgb));
    }

    [Fact]
    public void ReservedTierThrows()
    {
        byte[] rgba = Helpers.SolidImage(4, 4, 128, 128, 128, 255);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            CH.EncodeWithQuality(4, 4, rgba, Gamut.Srgb, CH.MaxTier + 1)
        );
    }

    /// <summary>
    /// The tier codes are declared as C# consts for constant expressions, but
    /// the format owns them and the native ABI exports them. Assert the two
    /// agree, so a renumber in the core cannot leave this package one code
    /// behind.
    /// </summary>
    [Fact]
    public void TierConstantsMatchTheNativeAbi()
    {
        Assert.Equal(CH.CompactTier, Native.ReadExportedByte("CHROMAHASH_COMPACT_TIER"));
        Assert.Equal(CH.DefaultTier, Native.ReadExportedByte("CHROMAHASH_DEFAULT_TIER"));
        Assert.Equal(CH.MaxTier, Native.ReadExportedByte("CHROMAHASH_MAX_TIER"));
    }
}

// ── Spec test vectors (parity gate) ─────────────────────────────────────────────

public class SpecVectorTests
{
    private static JsonElement[] LoadVectors(string name)
    {
        string path = Path.Combine(Helpers.SpecVectors, name);
        Assert.True(File.Exists(path), $"spec vector not found: {path}");
        return JsonSerializer.Deserialize<JsonElement[]>(File.ReadAllText(path))!;
    }

    private static byte[] Bytes(JsonElement arr) =>
        arr.EnumerateArray().Select(e => (byte)e.GetInt32()).ToArray();

    [Fact]
    public void IntegrationEncodeVectors()
    {
        var cases = LoadVectors("integration-encode.json");
        Assert.NotEmpty(cases);

        foreach (var tc in cases)
        {
            string name = tc.GetProperty("name").GetString()!;
            var input = tc.GetProperty("input");
            uint w = (uint)input.GetProperty("width").GetInt32();
            uint h = (uint)input.GetProperty("height").GetInt32();
            Gamut gamut = Helpers.GamutFromString(input.GetProperty("gamut").GetString()!);
            byte tier = (byte)input.GetProperty("tier").GetInt32();
            byte[] rgba = Bytes(input.GetProperty("rgba"));

            CH ch = CH.EncodeWithQuality(w, h, rgba, gamut, tier);
            Assert.True(ch.AsBytes().SequenceEqual(Bytes(tc.GetProperty("expected").GetProperty("hash"))), $"{name}: hash mismatch");
            Assert.True(ch.AverageColor().SequenceEqual(Bytes(tc.GetProperty("expected").GetProperty("average_color"))), $"{name}: average_color mismatch");
        }
    }

    [Fact]
    public void IntegrationDecodeVectors()
    {
        var cases = LoadVectors("integration-decode.json");
        Assert.NotEmpty(cases);

        foreach (var tc in cases)
        {
            string name = tc.GetProperty("name").GetString()!;
            CH ch = CH.FromBytes(Bytes(tc.GetProperty("input").GetProperty("hash")));
            var (w, h, rgba) = ch.Decode();
            var expected = tc.GetProperty("expected");

            Assert.Equal((uint)expected.GetProperty("width").GetInt32(), w);
            Assert.Equal((uint)expected.GetProperty("height").GetInt32(), h);
            Assert.True(rgba.SequenceEqual(Bytes(expected.GetProperty("rgba"))), $"{name}: rgba mismatch");
        }
    }

    [Fact]
    public void IntegrationDecodeCappedVectors()
    {
        var cases = LoadVectors("integration-decode-capped.json");
        Assert.NotEmpty(cases);

        foreach (var tc in cases)
        {
            string name = tc.GetProperty("name").GetString()!;
            var input = tc.GetProperty("input");
            CH ch = CH.FromBytes(Bytes(input.GetProperty("hash")));
            uint maxW = (uint)input.GetProperty("max_width").GetInt32();
            uint maxH = (uint)input.GetProperty("max_height").GetInt32();
            var (w, h, rgba) = ch.DecodeCapped(maxW, maxH);
            var expected = tc.GetProperty("expected");

            Assert.Equal((uint)expected.GetProperty("width").GetInt32(), w);
            Assert.Equal((uint)expected.GetProperty("height").GetInt32(), h);
            Assert.True(rgba.SequenceEqual(Bytes(expected.GetProperty("rgba"))), $"{name}: rgba mismatch");
        }
    }
}
