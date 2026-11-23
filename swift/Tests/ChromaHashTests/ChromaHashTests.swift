import ChromaHash
import Foundation
import Testing

// The Swift package is now a thin facade over UniFFI-generated bindings to the Rust
// core, so these tests exercise the public API end-to-end against the shared spec
// vectors — the cross-language parity gate. Per-function unit tests of the algorithm
// live in the Rust core (the single source of truth).

// MARK: - Spec Vector Loading

/// Resolve `spec/test-vectors/<name>` relative to this source file.
func specVectorPath(_ name: String, sourceFile: String = #filePath) -> URL {
  // <repo>/swift/Tests/ChromaHashTests/ChromaHashTests.swift -> <repo>/spec/test-vectors/<name>
  let testFile = URL(fileURLWithPath: sourceFile)
  let repoRoot =
    testFile
    .deletingLastPathComponent()  // ChromaHashTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // swift
    .deletingLastPathComponent()  // <repo>
  return repoRoot.appendingPathComponent("spec/test-vectors/\(name)")
}

func loadVectors(_ name: String) -> [[String: Any]] {
  let url = specVectorPath(name)
  guard let data = try? Data(contentsOf: url),
    let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [[String: Any]]
  else {
    Issue.record("could not load spec vectors: \(name)")
    return []
  }
  return json
}

/// A silent fallback to sRGB would report a *hash mismatch* for an unrecognised
/// gamut instead of naming the real cause — and would hide a spec vector whose
/// gamut this suite does not handle at all.
func gamutFromName(_ name: String) -> Gamut {
  switch name {
  case "sRGB": return .sRGB
  case "Display P3": return .displayP3
  case "Adobe RGB": return .adobeRGB
  case "BT.2020": return .bt2020
  case "ProPhoto RGB": return .proPhotoRGB
  default:
    Issue.record("unknown gamut in spec vector: \(name)")
    return .sRGB
  }
}

// MARK: - Integration: encode (spec vectors)

@Test func integrationEncodeVectors() throws {
  let raw = loadVectors("integration-encode.json")
  #expect(!raw.isEmpty)
  for tc in raw {
    let name = tc["name"] as? String ?? "?"
    guard let input = tc["input"] as? [String: Any],
      let width = input["width"] as? Int,
      let height = input["height"] as? Int,
      let gamutName = input["gamut"] as? String,
      let tier = input["tier"] as? Int,
      let rgbaNums = input["rgba"] as? [Int],
      let expected = tc["expected"] as? [String: Any],
      let hashNums = expected["hash"] as? [Int]
    else {
      Issue.record("malformed integration-encode entry: \(name)")
      continue
    }
    let hash = try ChromaHash.encodeWithQuality(
      width: width, height: height, rgba: rgbaNums.map { UInt8($0) },
      gamut: gamutFromName(gamutName), quality: UInt8(tier)
    )
    #expect(hash.hash == hashNums.map { UInt8($0) }, "\(name): encoded hash mismatch")
    if let avg = expected["average_color"] as? [Int], avg.count == 4 {
      let got = hash.averageColor()
      #expect([Int(got.r), Int(got.g), Int(got.b), Int(got.a)] == avg, "\(name): average_color")
    }
  }
}

// MARK: - Integration: decode (spec vectors)

@Test func integrationDecodeVectors() throws {
  let raw = loadVectors("integration-decode.json")
  #expect(!raw.isEmpty)
  for tc in raw {
    let name = tc["name"] as? String ?? "?"
    guard let input = tc["input"] as? [String: Any],
      let hashNums = input["hash"] as? [Int],
      let expected = tc["expected"] as? [String: Any],
      let expectedW = expected["width"] as? Int,
      let expectedH = expected["height"] as? Int,
      let expectedRGBA = expected["rgba"] as? [Int]
    else {
      Issue.record("malformed integration-decode entry: \(name)")
      continue
    }
    let (w, h, rgba) = try ChromaHash.fromBytes(hashNums.map { UInt8($0) }).decode()
    #expect(w == expectedW, "\(name): width")
    #expect(h == expectedH, "\(name): height")
    #expect(rgba.map { Int($0) } == expectedRGBA, "\(name): rgba")
  }
}

// MARK: - Integration: capped decode (spec vectors)

@Test func integrationDecodeCappedVectors() throws {
  let raw = loadVectors("integration-decode-capped.json")
  #expect(!raw.isEmpty)
  for tc in raw {
    let name = tc["name"] as? String ?? "?"
    guard let input = tc["input"] as? [String: Any],
      let hashNums = input["hash"] as? [Int],
      let maxW = input["max_width"] as? Int,
      let maxH = input["max_height"] as? Int,
      let expected = tc["expected"] as? [String: Any],
      let expectedW = expected["width"] as? Int,
      let expectedH = expected["height"] as? Int,
      let expectedRGBA = expected["rgba"] as? [Int]
    else {
      Issue.record("malformed integration-decode-capped entry: \(name)")
      continue
    }
    let (w, h, rgba) = try ChromaHash.fromBytes(hashNums.map { UInt8($0) })
      .decodeCapped(maxWidth: maxW, maxHeight: maxH)
    #expect(w == expectedW, "\(name): width")
    #expect(h == expectedH, "\(name): height")
    #expect(rgba.map { Int($0) } == expectedRGBA, "\(name): rgba")
  }
}

// MARK: - Public-API properties

@Test func encodeDecodeRoundtripDimensions() throws {
  let rgba: [UInt8] = Array(repeating: [128, 64, 32, 255], count: 16).flatMap { $0 }
  let hash = try ChromaHash.encode(width: 4, height: 4, rgba: rgba, gamut: .sRGB)
  let (w, h, pixels) = hash.decode()
  #expect(w > 0 && w <= 32)
  #expect(h > 0 && h <= 32)
  #expect(pixels.count == w * h * 4)
}

@Test func fromBytesRoundtrip() throws {
  let rgba: [UInt8] = Array(repeating: [128, 64, 32, 255], count: 16).flatMap { $0 }
  let hash = try ChromaHash.encode(width: 4, height: 4, rgba: rgba, gamut: .sRGB)
  #expect(try ChromaHash.fromBytes(hash.hash) == hash)
}

/// The byte length is a function of the tier alone, so assert all five — the
/// table spec §3.3 tabulates. Nothing in this suite had ever exercised a tier
/// other than the default outside the spec vectors.
@Test func eachTierEncodesToItsDocumentedLength() throws {
  let rgba: [UInt8] = Array(repeating: [128, 128, 128, 255], count: 16).flatMap { $0 }
  var lengths: [Int] = []
  for tier in ChromaHash.compactTier...ChromaHash.maxTier {
    lengths.append(
      try ChromaHash.encodeWithQuality(
        width: 4, height: 4, rgba: rgba, gamut: .sRGB, quality: tier
      ).hash.count)
  }
  #expect(lengths == [21, 32, 108, 411, 1623])
  #expect(try ChromaHash.encode(width: 4, height: 4, rgba: rgba, gamut: .sRGB).hash.count == 32)
}

/// Decoded dimensions come from the aspect byte and the tier's raster. A range
/// check wide enough to pass at every tier cannot tell them apart.
@Test func decodedDimensionsFollowTheTierRaster() throws {
  let rgba: [UInt8] = Array(repeating: [128, 64, 32, 255], count: 16).flatMap { $0 }
  var edges: [Int] = []
  for tier in ChromaHash.compactTier...ChromaHash.maxTier {
    let (w, h, pixels) = try ChromaHash.encodeWithQuality(
      width: 4, height: 4, rgba: rgba, gamut: .sRGB, quality: tier
    ).decode()
    #expect(w == h, "tier \(tier): raster should be square")
    #expect(pixels.count == w * h * 4)
    edges.append(w)
  }
  #expect(edges == [32, 32, 64, 128, 256])
}

// MARK: - Invalid input
//
// The core traps on all of these, and a trap must not cross the FFI boundary —
// the binding checks first and throws. Nothing in this suite had exercised the
// invalid-input path at all before.

@Test func fromBytesRejectsWrongLength() throws {
  let rgba: [UInt8] = Array(repeating: [128, 64, 32, 255], count: 16).flatMap { $0 }
  let valid = try ChromaHash.encode(width: 4, height: 4, rgba: rgba, gamut: .sRGB).hash

  #expect(throws: ChromaHashError.self) { try ChromaHash.fromBytes(Array(valid.dropLast())) }
  #expect(throws: ChromaHashError.self) { try ChromaHash.fromBytes(valid + [0]) }
  #expect(throws: ChromaHashError.self) { try ChromaHash.fromBytes([]) }
}

/// The reserved bit is how v1 reserves room for a future extension: a decoder
/// that ignored it would accept a hash written by a later format and render
/// garbage.
@Test func fromBytesRejectsAMalformedHeader() throws {
  let rgba: [UInt8] = Array(repeating: [128, 64, 32, 255], count: 16).flatMap { $0 }
  let valid = try ChromaHash.encode(width: 4, height: 4, rgba: rgba, gamut: .sRGB).hash

  let mutations: [(String, UInt8)] = [
    ("reserved bit set", valid[0] | 0b1000_0000),
    ("reserved tier code", (valid[0] & ~0b0011_1000) | ((ChromaHash.maxTier + 1) << 3)),
    ("unsupported version", valid[0] | 0b0000_0010),
  ]
  for (what, b0) in mutations {
    var bytes = valid
    bytes[0] = b0
    #expect(throws: ChromaHashError.self, "\(what)") { try ChromaHash.fromBytes(bytes) }
  }
}

@Test func encodeRejectsInvalidInput() {
  let rgba: [UInt8] = Array(repeating: [128, 64, 32, 255], count: 16).flatMap { $0 }
  #expect(throws: ChromaHashError.self) {
    try ChromaHash.encode(width: 0, height: 4, rgba: [], gamut: .sRGB)
  }
  #expect(throws: ChromaHashError.self) {
    try ChromaHash.encode(width: 4, height: 0, rgba: [], gamut: .sRGB)
  }
  #expect(throws: ChromaHashError.self) {
    try ChromaHash.encode(width: 4, height: 4, rgba: Array(rgba.dropLast()), gamut: .sRGB)
  }
  #expect(throws: ChromaHashError.self) {
    try ChromaHash.encodeWithQuality(
      width: 4, height: 4, rgba: rgba, gamut: .sRGB, quality: ChromaHash.maxTier + 1)
  }
}

/// The tier codes reach Swift through the FFI rather than being restated here,
/// so this asserts the ordering the format guarantees.
@Test func tierConstantsComeFromTheCore() {
  #expect(ChromaHash.compactTier == 0)
  #expect(ChromaHash.compactTier < ChromaHash.defaultTier)
  #expect(ChromaHash.defaultTier < ChromaHash.maxTier)
  #expect(ChromaHash.formatVersion == 1)
}
