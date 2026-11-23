import ChromaHashBindings
import Foundation

/// Gamut identifiers for source color spaces.
public enum Gamut: Sendable {
  case sRGB
  case displayP3
  case adobeRGB
  case bt2020
  case proPhotoRGB

  /// Map to the UniFFI-generated enum that crosses the FFI.
  var binding: ChromaHashBindings.Gamut {
    switch self {
    case .sRGB: return .srgb
    case .displayP3: return .displayP3
    case .adobeRGB: return .adobeRgb
    case .bt2020: return .bt2020
    case .proPhotoRGB: return .proPhotoRgb
    }
  }
}

/// Errors thrown by the encoding and decoding entry points.
///
/// Re-exported from the generated bindings rather than mirrored, so the case
/// list cannot drift. The variants match the C ABI's status codes: a caller
/// sees the same taxonomy whichever binding it went through.
public typealias ChromaHashError = ChromaHashBindings.ChromaHashError

/// ChromaHash: a compact LQIP (Low Quality Image Placeholder).
///
/// A thin facade over the UniFFI-generated bindings to the Rust core; output is
/// byte-identical to every other ChromaHash implementation. The hash is variable
/// length (32 bytes at the default quality tier) and native objects are created transiently
/// per operation.
public struct ChromaHash: Sendable, Equatable {
  // Read from the core across the FFI rather than restated here: the format
  // owns these codes, and a hand-written copy is free to drift from a
  // renumbering.

  /// The 21-byte compact tier — the smallest and lowest fidelity, rendered at
  /// ``defaultTier``'s resolution. Tier codes are ordered by quality (spec §2.5).
  public static let compactTier: UInt8 = ChromaHashBindings.compactTier()
  /// The 32-byte tier ``encode(width:height:rgba:gamut:)`` produces. Pass this
  /// rather than a literal — a bare 0 is the compact tier.
  public static let defaultTier: UInt8 = ChromaHashBindings.defaultTier()
  /// The highest valid tier code; codes 5...7 are reserved.
  public static let maxTier: UInt8 = ChromaHashBindings.maxTier()
  /// The format generation this build writes and accepts (the `version` field
  /// of byte 0).
  public static let formatVersion: UInt8 = ChromaHashBindings.formatVersion()

  /// The raw hash bytes (32 at the default tier, more at higher tiers).
  public let hash: [UInt8]

  /// Encode an image into a default-tier (32-byte) ChromaHash.
  ///
  /// - Parameters:
  ///   - width: image width (must be >= 1)
  ///   - height: image height (must be >= 1)
  ///   - rgba: pixel data in RGBA format (4 bytes per pixel)
  ///   - gamut: source color space
  /// - Throws: ``ChromaHashError`` if a dimension is zero or `rgba.count` is
  ///   not `width * height * 4`.
  public static func encode(width: Int, height: Int, rgba: [UInt8], gamut: Gamut) throws
    -> ChromaHash
  {
    return try encodeWithQuality(
      width: width, height: height, rgba: rgba, gamut: gamut, quality: Self.defaultTier)
  }

  /// Encode an image at an explicit quality tier (0...maxTier, ordered by
  /// quality). `defaultTier` is the 32-byte tier and `compactTier` the 21-byte
  /// one — pass those rather than a literal, since a bare 0 is the compact
  /// tier. Each higher code carries more detail in a larger hash.
  ///
  /// - Throws: ``ChromaHashError`` on a zero or out-of-range dimension, an
  ///   `rgba` length that disagrees with it, or a reserved tier code. The
  ///   core traps on all three, and a trap must not cross the FFI boundary,
  ///   so the binding checks first and throws.
  public static func encodeWithQuality(
    width: Int, height: Int, rgba: [UInt8], gamut: Gamut, quality: UInt8
  ) throws -> ChromaHash {
    guard let w = UInt32(exactly: width), let h = UInt32(exactly: height) else {
      throw ChromaHashError.InvalidDimensions(
        reason: "width and height must fit in a UInt32 (got \(width)x\(height))")
    }
    let obj = try ChromaHashBindings.ChromaHash.encodeWithQuality(
      w: w, h: h, rgba: Data(rgba), gamut: gamut.binding, quality: quality)
    return ChromaHash(hash: [UInt8](obj.asBytes()))
  }

  /// Decode a ChromaHash into an RGBA image in the given output gamut
  /// (`.sRGB`, `.displayP3`, or `.adobeRGB`; others fall back to sRGB).
  /// Returns (width, height, rgba_pixels).
  public func decode(to output: Gamut = .sRGB) -> (width: Int, height: Int, rgba: [UInt8]) {
    let result = binding().decodeTo(output: output.binding)
    return (Int(result.width), Int(result.height), [UInt8](result.rgba))
  }

  /// Decode a ChromaHash into an RGBA image, capped at the given maximum
  /// dimensions, in the given output gamut. Returns (width, height, rgba_pixels).
  public func decodeCapped(maxWidth: Int, maxHeight: Int, to output: Gamut = .sRGB) -> (
    width: Int, height: Int, rgba: [UInt8]
  ) {
    // Clamp rather than convert: `UInt32(maxWidth)` traps on a negative or
    // oversized cap, and a trap is exactly what the rest of this type was
    // changed to avoid.
    let result = binding().decodeCappedTo(
      maxW: UInt32(clamping: maxWidth), maxH: UInt32(clamping: maxHeight),
      output: output.binding)
    return (Int(result.width), Int(result.height), [UInt8](result.rgba))
  }

  /// Extract the average color without full decode. Returns (r, g, b, a) as UInt8 values.
  public func averageColor() -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8) {
    let c = binding().averageColor()
    return (UInt8(c.r), UInt8(c.g), UInt8(c.b), UInt8(c.a))
  }

  /// Create a ChromaHash from raw hash bytes, validating them up front.
  ///
  /// The format is self-describing, so the header fixes the exact byte
  /// length: a `ChromaHash` that comes back from `fromBytes` is guaranteed to
  /// decode.
  ///
  /// - Throws: ``ChromaHashError`` if the bytes are not a valid v2 ChromaHash
  ///   — bad version, reserved tier code, set reserved bit, or a length that
  ///   disagrees with the header.
  public static func fromBytes(_ bytes: [UInt8]) throws -> ChromaHash {
    _ = try ChromaHashBindings.ChromaHash.fromBytes(bytes: Data(bytes))
    return ChromaHash(hash: bytes)
  }

  /// Reconstruct the UniFFI object from the stored bytes.
  ///
  /// Every public construction path validates first, so this cannot fail for
  /// a value this API produced; a failure here would mean the type's own
  /// invariant was broken.
  private func binding() -> ChromaHashBindings.ChromaHash {
    // swiftlint:disable:next force_try
    try! ChromaHashBindings.ChromaHash.fromBytes(bytes: Data(hash))
  }
}
