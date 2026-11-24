namespace ChromaHash;

/// <summary>ChromaHash: a compact LQIP (Low Quality Image Placeholder).</summary>
/// <remarks>
/// A thin managed wrapper over the chromahash-c C ABI (which exposes the Rust
/// core via P/Invoke). Output is byte-identical to every other ChromaHash
/// implementation. The hash is variable length (32 bytes at the default quality tier);
/// native handles are created transiently per operation.
/// </remarks>
public sealed class ChromaHash : IEquatable<ChromaHash>
{
    /// <summary>
    /// The 21-byte compact tier — the smallest and lowest fidelity, rendered at
    /// <see cref="DefaultTier"/>'s resolution. Tier codes are ordered by quality.
    /// </summary>
    public const byte CompactTier = 0;

    /// <summary>
    /// The 32-byte tier <see cref="Encode"/> produces. Pass this rather than a
    /// literal — a bare 0 is the compact tier.
    /// </summary>
    public const byte DefaultTier = 1;

    /// <summary>The highest valid tier code; codes 5..=7 are reserved.</summary>
    public const byte MaxTier = 4;

    private readonly byte[] _hash;

    private ChromaHash(byte[] hash)
    {
        _hash = hash;
    }

    /// <summary>
    /// Encode an image into a ChromaHash.
    /// </summary>
    /// <param name="width">Image width (>= 1).</param>
    /// <param name="height">Image height (>= 1).</param>
    /// <param name="rgba">Pixel data in RGBA format (4 bytes per pixel, row-major).</param>
    /// <param name="gamut">Source color space.</param>
    public static ChromaHash Encode(uint width, uint height, byte[] rgba, Gamut gamut) =>
        EncodeWithQuality(width, height, rgba, gamut, DefaultTier);

    /// <summary>
    /// Encode an image at an explicit quality tier (0..=MaxTier, ordered by
    /// quality). <see cref="DefaultTier"/> is the 32-byte tier and
    /// <see cref="CompactTier"/> the 21-byte one — pass those rather than a
    /// literal, since a bare 0 is the compact tier.
    /// </summary>
    /// <param name="width">Image width (>= 1).</param>
    /// <param name="height">Image height (>= 1).</param>
    /// <param name="rgba">Pixel data in RGBA format (4 bytes per pixel, row-major).</param>
    /// <param name="gamut">Source color space.</param>
    /// <param name="quality">Quality tier (0..=<see cref="MaxTier"/>).</param>
    public static ChromaHash EncodeWithQuality(uint width, uint height, byte[] rgba, Gamut gamut, byte quality)
    {
        ArgumentNullException.ThrowIfNull(rgba);
        // Rejected natively too, but as a status code that carries no parameter
        // name; check here so the caller gets the argument that was wrong.
        if (quality > MaxTier)
            throw new ArgumentOutOfRangeException(
                nameof(quality),
                $"quality tier must be 0..={MaxTier}"
            );
        ThrowIfUndefined(gamut, nameof(gamut));
        var status = Native.chromahash_encode_with_quality(
            width,
            height,
            rgba,
            (nuint)rgba.Length,
            gamut,
            quality,
            out IntPtr handle
        );
        ThrowOnEncodeError(status, nameof(width));
        try
        {
            return new ChromaHash(ReadHash(handle));
        }
        finally
        {
            Native.chromahash_free(handle);
        }
    }

    /// <summary>
    /// Decode a ChromaHash into an RGBA image in the given output gamut
    /// (Srgb / DisplayP3 / AdobeRgb; others fall back to sRGB).
    /// Returns (width, height, rgba_pixels).
    /// </summary>
    public (uint Width, uint Height, byte[] Rgba) Decode(Gamut output = Gamut.Srgb)
    {
        ThrowIfUndefined(output, nameof(output));
        IntPtr handle = CreateHandle();
        try
        {
            var st = Native.chromahash_decode_to(handle, output, out Native.Image img);
            if (st != Native.Status.Ok)
                throw new InvalidOperationException($"chromahash decode failed: {st}");
            return ReadImage(ref img);
        }
        finally
        {
            Native.chromahash_free(handle);
        }
    }

    /// <summary>
    /// Decode a ChromaHash into an RGBA image, capped at the given maximum
    /// dimensions, in the given output gamut. Returns (width, height, rgba_pixels).
    /// </summary>
    public (uint Width, uint Height, byte[] Rgba) DecodeCapped(
        uint maxWidth, uint maxHeight, Gamut output = Gamut.Srgb)
    {
        ThrowIfUndefined(output, nameof(output));
        IntPtr handle = CreateHandle();
        try
        {
            var st = Native.chromahash_decode_capped_to(handle, maxWidth, maxHeight, output, out Native.Image img);
            if (st != Native.Status.Ok)
                throw new InvalidOperationException($"chromahash decode_capped failed: {st}");
            return ReadImage(ref img);
        }
        finally
        {
            Native.chromahash_free(handle);
        }
    }

    /// <summary>Extract the average color without full decode. Returns [r, g, b, a] as byte values.</summary>
    public byte[] AverageColor()
    {
        IntPtr handle = CreateHandle();
        try
        {
            var st = Native.chromahash_average_color(handle, out Native.Color c);
            if (st != Native.Status.Ok)
                throw new InvalidOperationException($"chromahash average_color failed: {st}");
            return [c.R, c.G, c.B, c.A];
        }
        finally
        {
            Native.chromahash_free(handle);
        }
    }

    /// <summary>
    /// Create a ChromaHash from raw hash bytes, validating them up front.
    /// </summary>
    /// <remarks>
    /// The format is self-describing, so the header determines the exact byte
    /// length; a ChromaHash that constructs is guaranteed to decode. Bad
    /// version, reserved tier code, set reserved bit, or a length that
    /// disagrees with the header all throw here rather than at first use.
    /// </remarks>
    /// <exception cref="ArgumentException">
    /// <paramref name="data"/> is not a valid v2 ChromaHash.
    /// </exception>
    public static ChromaHash FromBytes(byte[] data)
    {
        ArgumentNullException.ThrowIfNull(data);
        byte[] copy = new byte[data.Length];
        data.CopyTo(copy, 0);

        var status = Native.chromahash_from_bytes(copy, (nuint)copy.Length, out IntPtr handle);
        if (status != Native.Status.Ok || handle == IntPtr.Zero)
            throw new ArgumentException(
                $"not a valid ChromaHash ({status})",
                nameof(data)
            );
        Native.chromahash_free(handle);

        return new ChromaHash(copy);
    }

    /// <summary>Get the raw hash bytes (32 at the default tier, more at higher tiers).</summary>
    public byte[] AsBytes()
    {
        byte[] copy = new byte[_hash.Length];
        _hash.CopyTo(copy, 0);
        return copy;
    }

    // ── internals ──────────────────────────────────────────────────────────────

    /// <summary>Copy a native handle's variable-length bytes into a managed array.</summary>
    private static byte[] ReadHash(IntPtr handle)
    {
        int n = (int)Native.chromahash_byte_len(handle);
        byte[] hash = new byte[n];
        var st = Native.chromahash_as_bytes(handle, hash, (nuint)n);
        if (st != Native.Status.Ok)
            throw new InvalidOperationException($"chromahash as_bytes failed: {st}");
        return hash;
    }

    private IntPtr CreateHandle()
    {
        var status = Native.chromahash_from_bytes(_hash, (nuint)_hash.Length, out IntPtr handle);
        if (status != Native.Status.Ok || handle == IntPtr.Zero)
            throw new InvalidOperationException($"chromahash from_bytes failed: {status}");
        return handle;
    }

    private static (uint Width, uint Height, byte[] Rgba) ReadImage(ref Native.Image img)
    {
        try
        {
            int n = (int)img.RgbaLen;
            byte[] rgba = new byte[n];
            if (n > 0)
                System.Runtime.InteropServices.Marshal.Copy(img.Rgba, rgba, 0, n);
            return (img.Width, img.Height, rgba);
        }
        finally
        {
            Native.chromahash_image_free(ref img);
        }
    }

    /// <summary>
    /// A C# enum holds any int, so <c>(Gamut)5</c> compiles. The native ABI
    /// rejects it too, but as a bare status code; check here so the caller gets
    /// the argument that was wrong.
    /// </summary>
    private static void ThrowIfUndefined(Gamut gamut, string paramName)
    {
        if (!Enum.IsDefined(gamut))
            throw new ArgumentOutOfRangeException(
                paramName,
                $"gamut {(int)gamut} is not a defined Gamut"
            );
    }

    private static void ThrowOnEncodeError(Native.Status status, string paramName)
    {
        switch (status)
        {
            case Native.Status.Ok:
                return;
            case Native.Status.InvalidDimensions:
                throw new ArgumentOutOfRangeException(paramName, "width and height must be >= 1");
            case Native.Status.InvalidLength:
                throw new ArgumentException("rgba length must equal width * height * 4", paramName);
            case Native.Status.NullPointer:
                throw new ArgumentNullException(paramName);
            default:
                throw new InvalidOperationException($"chromahash encode failed: {status}");
        }
    }

    public bool Equals(ChromaHash? other)
    {
        if (other is null)
            return false;
        return _hash.AsSpan().SequenceEqual(other._hash);
    }

    public override bool Equals(object? obj) => obj is ChromaHash other && Equals(other);

    public override int GetHashCode()
    {
        var hc = new HashCode();
        foreach (byte b in _hash)
            hc.Add(b);
        return hc.ToHashCode();
    }

    public static bool operator ==(ChromaHash? left, ChromaHash? right) =>
        left?.Equals(right) ?? right is null;

    public static bool operator !=(ChromaHash? left, ChromaHash? right) => !(left == right);
}
