package io.chromahash.jvm

import io.chromahash.ffi.BatchEncoder
import io.chromahash.ffi.ChromaHash
import io.chromahash.ffi.ChromaHashException
import io.chromahash.ffi.Gamut
import io.chromahash.ffi.ImageInput
import io.chromahash.ffi.compactTier
import io.chromahash.ffi.defaultTier
import io.chromahash.ffi.formatVersion
import io.chromahash.ffi.maxTier
import org.json.JSONArray
import java.io.File
import java.nio.file.Paths
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Drives the spec test vectors through the UniFFI binding (`io.chromahash.ffi`),
 * proving the generated Kotlin + JNA + bundled native lib produce byte-identical
 * output to the Rust reference. This is the JVM module's enforced correctness gate.
 */
class ChromaHashTest {
    private fun specVectorsDir(): File {
        // <repo>/bindings/uniffi/jvm  ->  <repo>/spec/test-vectors
        val cwd = Paths.get("").toAbsolutePath().toFile()
        return cwd.resolve("../../../spec/test-vectors")
    }

    /**
     * A missing or empty vector file is a broken gate, not a reason to pass.
     * This used to return null on a missing file and every caller did `?: return`,
     * so renaming a vector file turned the enforced correctness gate into four
     * tests that asserted nothing and reported green.
     */
    private fun loadJsonArray(name: String): JSONArray {
        val f = specVectorsDir().resolve(name)
        assertTrue(f.exists(), "spec vector file not found: ${f.absolutePath}")
        val arr = JSONArray(f.readText())
        assertTrue(arr.length() > 0, "spec vector file is empty: $name")
        return arr
    }

    private fun gamutFromName(name: String): Gamut =
        when (name) {
            "sRGB" -> Gamut.SRGB
            "Display P3" -> Gamut.DISPLAY_P3
            "Adobe RGB" -> Gamut.ADOBE_RGB
            "BT.2020" -> Gamut.BT2020
            "ProPhoto RGB" -> Gamut.PRO_PHOTO_RGB
            // Falling back to sRGB turned an unrecognised gamut into a hash
            // mismatch on an unrelated assertion. Fail where the cause is.
            else -> throw IllegalArgumentException("unknown gamut in spec vector: $name")
        }

    @Test
    fun `spec vectors directory exists`() {
        val dir = specVectorsDir()
        assertTrue(dir.exists(), "spec vectors dir not found at ${dir.absolutePath}")
    }

    @Test
    fun `integration encode spec vectors`() {
        val arr = loadJsonArray("integration-encode.json")
        for (i in 0 until arr.length()) {
            val tc = arr.getJSONObject(i)
            val name = tc.getString("name")
            val input = tc.getJSONObject("input")
            val width = input.getInt("width")
            val height = input.getInt("height")
            val gamut = gamutFromName(input.getString("gamut"))
            val tier = input.getInt("tier")
            val rgbaArr = input.getJSONArray("rgba")
            val rgba = ByteArray(rgbaArr.length()) { (rgbaArr.getInt(it) and 0xFF).toByte() }
            val expected = tc.getJSONObject("expected")
            val expectedHashArr = expected.getJSONArray("hash")
            val expectedHash =
                ByteArray(expectedHashArr.length()) { (expectedHashArr.getInt(it) and 0xFF).toByte() }

            ChromaHash.encodeWithQuality(width.toUInt(), height.toUInt(), rgba, gamut, tier.toUByte()).use { hash ->
                assertContentEquals(expectedHash, hash.asBytes(), "$name: hash mismatch")
                if (expected.has("average_color")) {
                    val avgArr = expected.getJSONArray("average_color")
                    val avg = hash.averageColor()
                    assertEquals(avgArr.getInt(0), avg.r, "$name: avg.r")
                    assertEquals(avgArr.getInt(1), avg.g, "$name: avg.g")
                    assertEquals(avgArr.getInt(2), avg.b, "$name: avg.b")
                    assertEquals(avgArr.getInt(3), avg.a, "$name: avg.a")
                }
            }
        }
    }

    @Test
    fun `integration decode spec vectors`() {
        val arr = loadJsonArray("integration-decode.json")
        for (i in 0 until arr.length()) {
            val tc = arr.getJSONObject(i)
            val name = tc.getString("name")
            val input = tc.getJSONObject("input")
            val hashArr = input.getJSONArray("hash")
            val hashBytes = ByteArray(hashArr.length()) { (hashArr.getInt(it) and 0xFF).toByte() }
            val expected = tc.getJSONObject("expected")
            val expectedW = expected.getInt("width")
            val expectedH = expected.getInt("height")
            val expectedRgba = expected.getJSONArray("rgba")

            ChromaHash.fromBytes(hashBytes).use { hash ->
                val result = hash.decode()
                assertEquals(expectedW, result.width, "$name: width")
                assertEquals(expectedH, result.height, "$name: height")
                assertEquals(expectedRgba.length(), result.rgba.size, "$name: rgba length")
                for (j in 0 until result.rgba.size) {
                    val got = result.rgba[j].toInt() and 0xFF
                    assertTrue(
                        abs(got - expectedRgba.getInt(j)) <= 1,
                        "$name: rgba[$j] expected ${expectedRgba.getInt(j)}, got $got",
                    )
                }
            }
        }
    }

    @Test
    fun `integration decode capped spec vectors`() {
        val arr = loadJsonArray("integration-decode-capped.json")
        for (i in 0 until arr.length()) {
            val tc = arr.getJSONObject(i)
            val name = tc.getString("name")
            val input = tc.getJSONObject("input")
            val hashArr = input.getJSONArray("hash")
            val hashBytes = ByteArray(hashArr.length()) { (hashArr.getInt(it) and 0xFF).toByte() }
            val maxW = input.getInt("max_width")
            val maxH = input.getInt("max_height")
            val expected = tc.getJSONObject("expected")
            val expectedW = expected.getInt("width")
            val expectedH = expected.getInt("height")
            val expectedRgba = expected.getJSONArray("rgba")

            ChromaHash.fromBytes(hashBytes).use { hash ->
                val result = hash.decodeCapped(maxW.toUInt(), maxH.toUInt())
                assertEquals(expectedW, result.width, "$name: width")
                assertEquals(expectedH, result.height, "$name: height")
                assertEquals(expectedRgba.length(), result.rgba.size, "$name: rgba length")
                for (j in 0 until result.rgba.size) {
                    val got = result.rgba[j].toInt() and 0xFF
                    assertTrue(
                        abs(got - expectedRgba.getInt(j)) <= 1,
                        "$name: rgba[$j] expected ${expectedRgba.getInt(j)}, got $got",
                    )
                }
            }
        }
    }

    private fun solid4x4(): ByteArray =
        ByteArray(64) { i ->
            when (i % 4) {
                0 -> 128.toByte()
                1 -> 64.toByte()
                2 -> 32.toByte()
                else -> 255.toByte()
            }
        }

    /**
     * A fixed length is not a valid assertion about any tier: each has its own,
     * and a bare 16/64 pair says nothing about the ones in between. Derive each
     * length from a real encode, then bracket it.
     */
    @Test
    fun `fromBytes accepts every tier and rejects wrong lengths`() {
        val rgba = solid4x4()
        for (tier in 0..MAX_TIER) {
            val encoded =
                ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, tier.toUByte()).use {
                    it.asBytes()
                }
            ChromaHash.fromBytes(encoded).use { /* accepted */ }

            assertFailsWith<Exception>("tier $tier: accepted a buffer one byte short") {
                ChromaHash.fromBytes(encoded.copyOf(encoded.size - 1))
            }
            assertFailsWith<Exception>("tier $tier: accepted a buffer one byte long") {
                ChromaHash.fromBytes(encoded.copyOf(encoded.size + 1))
            }
        }
    }

    /**
     * The byte length is a function of the tier alone, so it is checkable
     * exactly rather than as a range. These are the lengths spec §3.3 tabulates.
     */
    @Test
    fun `each tier encodes to its documented length`() {
        val rgba = solid4x4()
        val expected = mapOf(0 to 21, 1 to 32, 2 to 108, 3 to 411, 4 to 1623)
        for ((tier, bytes) in expected) {
            ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, tier.toUByte()).use { hash ->
                assertEquals(bytes, hash.asBytes().size, "tier $tier byte length")
            }
        }
    }

    /**
     * Decoded dimensions come from the aspect byte and the tier's raster, not
     * from the input size — so assert the values, not a range wide enough to
     * pass for any of them.
     */
    @Test
    fun `decoded dimensions follow the tier raster`() {
        val rgba = solid4x4()
        val expected = mapOf(0 to 32, 1 to 32, 2 to 64, 3 to 128, 4 to 256)
        for ((tier, edge) in expected) {
            ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, tier.toUByte()).use { hash ->
                val result = hash.decode()
                assertEquals(edge, result.width.toInt(), "tier $tier width")
                assertEquals(edge, result.height.toInt(), "tier $tier height")
                assertEquals(result.width.toInt() * result.height.toInt() * 4, result.rgba.size)
            }
        }
    }

    /**
     * The reserved bit is how v1 reserves room for a future extension: a decoder
     * that ignored it would accept a hash written by a later format and render
     * garbage. Neither it nor a reserved tier code was exercised here.
     */
    @Test
    fun `fromBytes rejects a malformed header`() {
        val valid = ChromaHash.encode(4u, 4u, solid4x4(), Gamut.SRGB).use { it.asBytes() }

        val cases =
            mapOf(
                "reserved bit set" to (valid[0].toInt() or 0b1000_0000),
                "reserved tier code" to
                    ((valid[0].toInt() and 0b0011_1000.inv()) or ((MAX_TIER + 1) shl 3)),
                "unsupported version" to (valid[0].toInt() or 0b0000_0010),
            )

        for ((what, b0) in cases) {
            val bytes = valid.copyOf()
            bytes[0] = b0.toByte()
            assertFailsWith<ChromaHashException.InvalidData>(what) {
                ChromaHash.fromBytes(bytes)
            }
        }
    }

    /**
     * The core panics on invalid input, and a panic across the FFI boundary is
     * undefined behaviour — so the binding validates first and throws a typed
     * error, matching the C ABI's status codes.
     */
    @Test
    fun `encode rejects invalid dimensions`() {
        assertFailsWith<ChromaHashException.InvalidDimensions> {
            ChromaHash.encode(0u, 4u, ByteArray(0), Gamut.SRGB)
        }
        assertFailsWith<ChromaHashException.InvalidDimensions> {
            ChromaHash.encode(4u, 0u, ByteArray(0), Gamut.SRGB)
        }
        // rgba shorter than w * h * 4
        assertFailsWith<ChromaHashException.InvalidLength> {
            ChromaHash.encode(4u, 4u, ByteArray(63), Gamut.SRGB)
        }
    }

    @Test
    fun `encodeWithQuality rejects a reserved tier code`() {
        val rgba = solid4x4()
        assertFailsWith<ChromaHashException.InvalidTier> {
            ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, (MAX_TIER + 1).toUByte())
        }
    }

    /**
     * Pins the tier down to the byte count. Comparing the batch against the
     * serial path alone would pass if both silently used one tier.
     */
    @Test
    fun `batch encoding honors each item's tier`() {
        val rgba = solid4x4()
        val items = (0..MAX_TIER).map { ImageInput(4u, 4u, rgba, Gamut.SRGB, it.toUByte()) }
        BatchEncoder().use { encoder ->
            val lengths = encoder.encodeBatch(items).map { it.use { h -> h.asBytes().size } }
            assertContentEquals(listOf(21, 32, 108, 411, 1623), lengths)
        }
    }

    /**
     * An item with no explicit tier must match `encode` — the codes are ordered
     * by quality, so a zero default would be the 21-byte compact tier.
     */
    @Test
    fun `batch encoding defaults to the default tier`() {
        val rgba = solid4x4()
        val expected = ChromaHash.encode(4u, 4u, rgba, Gamut.SRGB).use { it.asBytes() }
        BatchEncoder().use { encoder ->
            val batched =
                encoder.encodeBatch(listOf(ImageInput(4u, 4u, rgba, Gamut.SRGB))).single().use {
                    it.asBytes()
                }
            assertContentEquals(expected, batched)
        }
    }

    @Test
    fun `batch encoding rejects a reserved tier code, naming the item`() {
        val rgba = solid4x4()
        val items =
            listOf(
                ImageInput(4u, 4u, rgba, Gamut.SRGB),
                ImageInput(4u, 4u, rgba, Gamut.SRGB, (MAX_TIER + 1).toUByte()),
            )
        BatchEncoder().use { encoder ->
            val e =
                assertFailsWith<ChromaHashException.InvalidTier> { encoder.encodeBatch(items) }
            assertTrue(e.message!!.contains("item 1"), "error should name the item: ${e.message}")
        }
    }

    /**
     * The tier codes reach Kotlin through the FFI rather than being restated
     * here, so this asserts the ordering the format guarantees.
     */
    @Test
    fun `tier constants come from the core`() {
        // Not `assertEquals(MAX_TIER, maxTier())` — MAX_TIER *is* maxTier(), so
        // that asserts nothing. What is checkable is the contract the format
        // guarantees about the codes, and the byte lengths they select.
        assertEquals(0, compactTier().toInt())
        assertEquals(1, formatVersion().toInt())
        assertTrue(compactTier() < defaultTier() && defaultTier() < maxTier())

        val rgba = solid4x4()
        assertEquals(
            21,
            ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, compactTier()).use {
                it.asBytes().size
            },
            "compactTier() must select the 21-byte tier",
        )
        assertEquals(
            32,
            ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, defaultTier()).use {
                it.asBytes().size
            },
            "defaultTier() must select the 32-byte tier",
        )
        assertFailsWith<ChromaHashException.InvalidTier> {
            ChromaHash.encodeWithQuality(4u, 4u, rgba, Gamut.SRGB, (maxTier() + 1u).toUByte())
        }
    }

    private companion object {
        /** Highest tier code the format defines; codes above it are reserved. */
        val MAX_TIER = maxTier().toInt()
    }
}
