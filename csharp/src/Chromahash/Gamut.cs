namespace ChromaHash;

/// <summary>
/// Gamut identifiers for source color spaces. Values match the chromahash-c
/// ABI's CHROMA_HASH_GAMUT_* constants (and the Rust core's Gamut), so the
/// value crosses the FFI directly. A value outside the enum throws
/// <see cref="ArgumentOutOfRangeException"/> before it reaches the ABI.
/// </summary>
public enum Gamut
{
    Srgb,
    DisplayP3,
    AdobeRgb,
    Bt2020,
    ProPhotoRgb,
}
