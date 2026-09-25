/// Write `count` bits of `value` starting at `bitpos` in little-endian byte order.
/// Per spec §12.6 writeBits.
pub fn write_bits(hash: &mut [u8], bitpos: usize, count: u32, value: u32) {
    for i in 0..count as usize {
        let byte_idx = (bitpos + i) / 8;
        let bit_idx = (bitpos + i) % 8;
        if (value >> i) & 1 != 0 {
            hash[byte_idx] |= 1 << bit_idx;
        }
    }
}

/// [`write_bits`], a byte-span at a time: each byte the field touches is
/// OR-ed once with the run of the field's bits that lands in it, instead of
/// once per bit — `spec/PERFORMANCE.md` §12.1 item 7.
///
/// The same bits reach the same positions. `write_bits` sets bit `i` of
/// `value` (for `i < count`) at stream position `bitpos + i`, byte
/// `(bitpos + i) / 8`, bit `(bitpos + i) % 8`, and never clears a bit; this
/// takes the bits of `value` in the same order, masks off everything at and
/// above `count` exactly as the per-bit loop never looks there, and ORs each
/// byte's run in at the same offset.
pub fn write_bits_bytewise(hash: &mut [u8], bitpos: usize, count: u32, value: u32) {
    debug_assert!(count <= 32, "a field is at most 32 bits wide");
    let mut v = if count >= 32 {
        value as u64
    } else {
        (value as u64) & ((1u64 << count) - 1)
    };
    let mut pos = bitpos;
    let mut remaining = count as usize;
    while remaining > 0 {
        let off = pos % 8;
        let take = (8 - off).min(remaining);
        let run = (v & ((1u64 << take) - 1)) as u8;
        hash[pos / 8] |= run << off;
        v >>= take;
        pos += take;
        remaining -= take;
    }
}

/// Read `count` bits starting at `bitpos` in little-endian byte order.
/// Per spec §12.6 readBits.
pub fn read_bits(hash: &[u8], bitpos: usize, count: u32) -> u32 {
    let mut value = 0u32;
    for i in 0..count as usize {
        let byte_idx = (bitpos + i) / 8;
        let bit_idx = (bitpos + i) % 8;
        if hash[byte_idx] & (1 << bit_idx) != 0 {
            value |= 1 << i;
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_basic() {
        let mut buf = [0u8; 4];
        write_bits(&mut buf, 0, 8, 0xAB);
        assert_eq!(read_bits(&buf, 0, 8), 0xAB);
    }

    #[test]
    fn roundtrip_at_offset() {
        let mut buf = [0u8; 4];
        write_bits(&mut buf, 3, 5, 0x1F);
        assert_eq!(read_bits(&buf, 3, 5), 0x1F);
    }

    #[test]
    fn cross_byte_boundary() {
        let mut buf = [0u8; 4];
        write_bits(&mut buf, 6, 8, 0xCA);
        assert_eq!(read_bits(&buf, 6, 8), 0xCA);
    }

    #[test]
    fn multiple_fields() {
        let mut buf = [0u8; 8];
        write_bits(&mut buf, 0, 7, 100);
        write_bits(&mut buf, 7, 7, 64);
        write_bits(&mut buf, 14, 7, 80);
        write_bits(&mut buf, 21, 6, 33);
        write_bits(&mut buf, 27, 6, 20);
        write_bits(&mut buf, 33, 5, 15);
        write_bits(&mut buf, 38, 8, 128);
        write_bits(&mut buf, 46, 1, 1);
        write_bits(&mut buf, 47, 1, 0);

        assert_eq!(read_bits(&buf, 0, 7), 100);
        assert_eq!(read_bits(&buf, 7, 7), 64);
        assert_eq!(read_bits(&buf, 14, 7), 80);
        assert_eq!(read_bits(&buf, 21, 6), 33);
        assert_eq!(read_bits(&buf, 27, 6), 20);
        assert_eq!(read_bits(&buf, 33, 5), 15);
        assert_eq!(read_bits(&buf, 38, 8), 128);
        assert_eq!(read_bits(&buf, 46, 1), 1);
        assert_eq!(read_bits(&buf, 47, 1), 0);
    }

    #[test]
    fn bytewise_writes_the_same_bits() {
        // Every start offset across three bytes, every width, and values with
        // bits set above `count` (which both writers must ignore), written into
        // buffers that already hold bits (both writers only ever OR).
        let mut s: u32 = 0x9e37_79b9;
        let mut next = || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            s
        };
        for bitpos in 0..24usize {
            for count in 0..=32u32 {
                for _ in 0..8 {
                    let value = next();
                    let fill = next();
                    let mut a = [0u8; 12];
                    for (k, byte) in a.iter_mut().enumerate() {
                        // Pre-set a sparse pattern so an erroneous clear shows.
                        *byte = ((fill >> (k % 4 * 8)) as u8) & 0x11;
                    }
                    let mut b = a;
                    write_bits(&mut a, bitpos, count, value);
                    write_bits_bytewise(&mut b, bitpos, count, value);
                    assert_eq!(a, b, "bitpos={bitpos} count={count} value={value:#x}");
                }
            }
        }
    }

    #[test]
    fn zero_value() {
        let mut buf = [0u8; 4];
        write_bits(&mut buf, 0, 8, 0);
        assert_eq!(read_bits(&buf, 0, 8), 0);
    }

    #[test]
    fn max_values() {
        for bits in 1..=8 {
            let max = (1u32 << bits) - 1;
            let mut buf = [0u8; 4];
            write_bits(&mut buf, 0, bits, max);
            assert_eq!(read_bits(&buf, 0, bits), max);
        }
    }
}
