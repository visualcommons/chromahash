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

/// [`write_bits`], a word at a time: the field is masked and shifted into
/// place in one 64-bit word, and each byte it touches is OR-ed once, instead
/// of once per bit — `spec/PERFORMANCE.md` §12.1 item 7.
///
/// The same bits reach the same positions. `write_bits` sets bit `i` of
/// `value` (for `i < count`) at stream position `bitpos + i` — byte
/// `(bitpos + i) / 8`, bit `(bitpos + i) % 8` — and never clears a bit. Here
/// bit `i` of the masked value is bit `bitpos % 8 + i` of the shifted word,
/// which is bit `(bitpos + i) % 8` of word byte `k = (bitpos % 8 + i) / 8`,
/// written to `hash[bitpos / 8 + k]`: the same byte. The mask drops every bit
/// at and above `count`, which the per-bit loop never reads. A field is at
/// most 32 bits and its offset in a byte at most 7, so the word never
/// overflows its 64 bits.
///
/// Every loop here is a bounded `for`: a mutated bound cannot turn it into one
/// that never ends.
pub fn write_bits_word(hash: &mut [u8], bitpos: usize, count: u32, value: u32) {
    debug_assert!(count <= 32, "a field is at most 32 bits wide");
    if count == 0 {
        return;
    }
    let word = ((value as u64) & ((1u64 << count) - 1)) << (bitpos % 8);
    let first = bitpos / 8;
    let last = (bitpos + count as usize - 1) / 8;
    for (k, byte) in hash[first..=last].iter_mut().enumerate() {
        *byte |= (word >> (8 * k)) as u8;
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

// ── Entropy-coded AC (register entry D1; sweep-only, off by default) ──────
//
// `Tunables::ac_coder = 1` replaces the fixed-width AC fields with one
// adaptive binary arithmetic-coded stream that fills the rest of the hash, at
// the byte length the shipped layout gives the same (tier, alpha mode). The
// coder is the integer interval coder of Witten, Neal and Cleary (1987) over
// binary decisions, with 12-bit adaptive probabilities. It needs no table:
// every model starts at one half and adapts as it codes.
//
// **It is a total code** (D1's validity design (b)): the decoder reads a
// fixed number of symbols, every one of them in range by construction, and
// treats every bit past the end of the hash as zero, so *every* bit string of
// the header-implied length decodes. The interval invariant
// `low <= value <= high` holds for any input, not only for an encoder's
// output: each decision picks the half of `[low, high]` that holds `value`,
// and each renormalisation maps all three by the same affine step. So
// `from_bytes` keeps its O(1) length check as the complete validity check.

/// Probability precision: a model holds P(bit = 0) in units of 2^-12.
const PROB_BITS: u32 = 12;
/// Slowest adaptation rate: once a model has coded three bits, each further
/// bit moves it 1/16 of the way toward that bit.
const ADAPT_SHIFT: u32 = 4;
const HALF: u64 = 1 << 31;
const QUARTER: u64 = 1 << 30;
const THREE_QUARTERS: u64 = 3 << 30;
const TOP: u64 = (1 << 32) - 1;

/// One adaptive binary model: P(bit = 0) in 1/4096, and how many bits it has
/// coded (saturating at `ADAPT_SHIFT - 1`).
///
/// The `n`-th update moves the estimate by `2^-min(n + 1, 4)` of the
/// distance to the bit, so a fresh model learns fast (half the way on its
/// first bit) and settles at 1/16. A short stream — a code-2 hash codes a
/// few hundred decisions over dozens of models — never pays for starting
/// slow. Neither update leaves `[1, 4095]` (each moves by a floor of a
/// fraction of the distance to 0 or 4096), so neither sub-interval is ever
/// empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BitModel(u16, u8);

impl BitModel {
    /// Even odds, nothing coded.
    pub(crate) const NEW: BitModel = BitModel(1 << (PROB_BITS - 1), 0);

    /// Move the estimate toward the bit just coded.
    fn update(&mut self, bit: bool) {
        let shift = 1 + self.1 as u32;
        if shift < ADAPT_SHIFT {
            self.1 += 1;
        }
        if bit {
            self.0 -= self.0 >> shift;
        } else {
            self.0 += ((1u16 << PROB_BITS) - self.0) >> shift;
        }
    }
}

/// The split point of `[low, high]` for a P(0) of `p0` / 4096: the zero
/// branch is `[low, split]`, the one branch `[split + 1, high]`. With the
/// interval wider than a quarter of 2^32 (renormalisation keeps it so) and
/// `p0` in `[1, 4095]`, both branches are non-empty.
fn split_point(low: u64, high: u64, p0: u16) -> u64 {
    let range = high - low + 1;
    low + ((range * p0 as u64) >> PROB_BITS) - 1
}

/// Arithmetic encoder writing a bit string, least significant bit of each
/// byte first (the order [`write_bits`] uses).
pub(crate) struct ArithEncoder {
    low: u64,
    high: u64,
    pending: u64,
    out: Vec<u8>,
    nbits: usize,
}

impl ArithEncoder {
    pub(crate) fn new() -> Self {
        Self {
            low: 0,
            high: TOP,
            pending: 0,
            out: Vec::new(),
            nbits: 0,
        }
    }

    fn push(&mut self, bit: bool) {
        if self.nbits % 8 == 0 {
            self.out.push(0);
        }
        if bit {
            self.out[self.nbits / 8] |= 1 << (self.nbits % 8);
        }
        self.nbits += 1;
    }

    fn emit(&mut self, bit: bool) {
        self.push(bit);
        for _ in 0..self.pending {
            self.push(!bit);
        }
        self.pending = 0;
    }

    fn encode_p(&mut self, bit: bool, p0: u16) {
        let split = split_point(self.low, self.high, p0);
        if bit {
            self.low = split + 1;
        } else {
            self.high = split;
        }
        // Renormalise. Every pass doubles the interval, which starts at least
        // 2 wide, so the loop ends within 32 passes.
        for _ in 0..64 {
            if self.high < HALF {
                self.emit(false);
            } else if self.low >= HALF {
                self.emit(true);
                self.low -= HALF;
                self.high -= HALF;
            } else if self.low >= QUARTER && self.high < THREE_QUARTERS {
                self.pending += 1;
                self.low -= QUARTER;
                self.high -= QUARTER;
            } else {
                break;
            }
            // `+ 1`, not `| 1`: the shift leaves bit 0 clear, so the two are
            // the same value, and `+` is the one whose mutants change it.
            self.low <<= 1;
            self.high = (self.high << 1) + 1;
        }
    }

    /// Code `bit` against `model`, then adapt it.
    pub(crate) fn encode(&mut self, bit: bool, model: &mut BitModel) {
        self.encode_p(bit, model.0);
        model.update(bit);
    }

    /// Code `bit` at even odds, with no model (a sign).
    pub(crate) fn encode_bypass(&mut self, bit: bool) {
        self.encode_p(bit, BitModel::NEW.0);
    }

    /// Terminate: one more decision bit (plus whatever is pending) selects a
    /// point of the final interval that the decoder's zero fill reproduces —
    /// `0100…` (= a quarter) when `low` is below a quarter, else `100…`
    /// (= a half), and both lie inside `[low, high]` after renormalisation.
    /// Trailing zero bits are then dropped, since the decoder reads every bit
    /// past the stream as zero. Returns the bytes and the bit count.
    ///
    /// The strip needs no `nbits > 0` guard: the termination always emits a
    /// one (the `1` itself, or the pending `1` after a `0`), so it stops at
    /// that bit at the latest.
    pub(crate) fn finish(mut self) -> (Vec<u8>, usize) {
        self.pending += 1;
        let bit = self.low >= QUARTER;
        self.emit(bit);
        while (self.out[(self.nbits - 1) / 8] >> ((self.nbits - 1) % 8)) & 1 == 0 {
            self.nbits -= 1;
        }
        self.out.truncate(self.nbits.div_ceil(8));
        (self.out, self.nbits)
    }
}

/// Arithmetic decoder over the bit range `[start, end)` of a byte string.
/// Every bit at or past `end` reads as zero, so it decodes any input.
pub(crate) struct ArithDecoder<'a> {
    data: &'a [u8],
    pos: usize,
    end: usize,
    low: u64,
    high: u64,
    value: u64,
}

impl<'a> ArithDecoder<'a> {
    pub(crate) fn new(data: &'a [u8], start: usize, end: usize) -> Self {
        let end = end.min(data.len() * 8);
        let mut d = Self {
            data,
            pos: start,
            end,
            low: 0,
            high: TOP,
            value: 0,
        };
        for _ in 0..32 {
            d.value = (d.value << 1) + d.next_bit();
        }
        d
    }

    fn next_bit(&mut self) -> u64 {
        let bit = if self.pos < self.end {
            ((self.data[self.pos / 8] >> (self.pos % 8)) & 1) as u64
        } else {
            0
        };
        self.pos += 1;
        bit
    }

    fn decode_p(&mut self, p0: u16) -> bool {
        let split = split_point(self.low, self.high, p0);
        let bit = self.value > split;
        if bit {
            self.low = split + 1;
        } else {
            self.high = split;
        }
        for _ in 0..64 {
            if self.high < HALF {
            } else if self.low >= HALF {
                self.low -= HALF;
                self.high -= HALF;
                self.value -= HALF;
            } else if self.low >= QUARTER && self.high < THREE_QUARTERS {
                self.low -= QUARTER;
                self.high -= QUARTER;
                self.value -= QUARTER;
            } else {
                break;
            }
            self.low <<= 1;
            self.high = (self.high << 1) + 1;
            self.value = (self.value << 1) + self.next_bit();
        }
        bit
    }

    /// Decode one bit against `model`, then adapt it as the encoder did.
    pub(crate) fn decode(&mut self, model: &mut BitModel) -> bool {
        let bit = self.decode_p(model.0);
        model.update(bit);
        bit
    }

    /// Decode one even-odds bit.
    pub(crate) fn decode_bypass(&mut self) -> bool {
        self.decode_p(BitModel::NEW.0)
    }
}

/// Channel groups with their own models: luma, chroma (a and b share), alpha.
pub(crate) const AC_GROUPS: usize = 3;
/// Frequency bands by selection index: band `floor(log2(i + 1))`, capped.
const AC_BANDS: usize = 12;
/// Magnitude bins with their own model; later bins share the last.
const MAG_BINS: usize = 4;

/// The adaptive models of one coded AC stream. A code `q` of a `bits`-wide
/// odd-level field (centre `c = 2^(bits-1) - 1`, codes `0..=2c`) is coded as
/// the signed offset `s = q - c`:
///
/// 1. a significance bit (`s != 0`), modelled by group, band and how many of
///    the channel's previous two codes were significant;
/// 2. for `s != 0`, the sign at even odds;
/// 3. `|s| - 1` in truncated unary up to `c - 1`, each bin modelled by group,
///    band and bin index (bins past [`MAG_BINS`] share one model).
///
/// Every path ends with `|s| <= c`, so a decoded code is always in range.
pub(crate) struct AcModels {
    sig: [[[BitModel; 3]; AC_BANDS]; AC_GROUPS],
    mag: [[[BitModel; MAG_BINS]; AC_BANDS]; AC_GROUPS],
}

/// Per-channel coding history: the significance of the previous two codes.
#[derive(Clone, Copy, Default)]
pub(crate) struct AcHistory(u8);

impl AcHistory {
    fn context(self) -> usize {
        ((self.0 & 1) + ((self.0 >> 1) & 1)) as usize
    }
    fn push(&mut self, significant: bool) {
        // `+`, not `|`: the shift leaves bit 0 clear (see `encode_p`).
        self.0 = ((self.0 << 1) + significant as u8) & 3;
    }
}

/// The frequency band of selection index `index`: `floor(log2(index + 1))`,
/// capped at the last band.
fn ac_band(index: usize) -> usize {
    ((usize::BITS - 1 - (index + 1).leading_zeros()) as usize).min(AC_BANDS - 1)
}

impl AcModels {
    pub(crate) fn new() -> Self {
        Self {
            sig: [[[BitModel::NEW; 3]; AC_BANDS]; AC_GROUPS],
            mag: [[[BitModel::NEW; MAG_BINS]; AC_BANDS]; AC_GROUPS],
        }
    }

    /// Code one AC code `q` of a `bits`-wide field at selection `index`.
    pub(crate) fn encode(
        &mut self,
        enc: &mut ArithEncoder,
        hist: &mut AcHistory,
        group: usize,
        index: usize,
        bits: u32,
        q: u32,
    ) {
        let center = (1u32 << (bits - 1)) - 1;
        if center == 0 {
            return;
        }
        let q = q.min(2 * center);
        let band = ac_band(index);
        // One three-way comparison: a `<` beside a `!=` would leave its own
        // `<=` mutant equivalent, since the sign is only coded when `q`
        // differs from the centre.
        let (significant, negative, mag) = match q.cmp(&center) {
            core::cmp::Ordering::Equal => (false, false, 0),
            core::cmp::Ordering::Less => (true, true, center - q),
            core::cmp::Ordering::Greater => (true, false, q - center),
        };
        enc.encode(significant, &mut self.sig[group][band][hist.context()]);
        hist.push(significant);
        if !significant {
            return;
        }
        enc.encode_bypass(negative);
        for j in 0..center - 1 {
            let more = mag > j + 1;
            enc.encode(
                more,
                &mut self.mag[group][band][(j as usize).min(MAG_BINS - 1)],
            );
            if !more {
                break;
            }
        }
    }

    /// Decode one AC code; the inverse of [`encode`](Self::encode). Total:
    /// it returns a code in `0..=2^bits - 2` for any input bits.
    pub(crate) fn decode(
        &mut self,
        dec: &mut ArithDecoder,
        hist: &mut AcHistory,
        group: usize,
        index: usize,
        bits: u32,
    ) -> u32 {
        let center = (1u32 << (bits - 1)) - 1;
        if center == 0 {
            return 0;
        }
        let band = ac_band(index);
        let significant = dec.decode(&mut self.sig[group][band][hist.context()]);
        hist.push(significant);
        if !significant {
            return center;
        }
        let negative = dec.decode_bypass();
        let mut mag = 1u32;
        for j in 0..center - 1 {
            if !dec.decode(&mut self.mag[group][band][(j as usize).min(MAG_BINS - 1)]) {
                break;
            }
            mag += 1;
        }
        if negative { center - mag } else { center + mag }
    }
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
    fn word_writer_writes_the_same_bits() {
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
                    write_bits_word(&mut b, bitpos, count, value);
                    assert_eq!(a, b, "bitpos={bitpos} count={count} value={value:#x}");
                }
            }
        }
    }

    #[test]
    fn write_bits_lands_in_the_addressed_bytes() {
        // Exact bytes, not a round trip through `read_bits`: a writer that
        // computes the wrong byte index from `bitpos + i` must show here, at
        // an offset where it cannot underflow, rather than downstream as a
        // scrambled descriptor byte (which can name a reserved tier and send
        // a decode test into a minutes-long render).
        let mut buf = [0u8; 4];
        write_bits(&mut buf, 8, 8, 0xAB);
        assert_eq!(buf, [0, 0xAB, 0, 0]);
        let mut buf = [0u8; 4];
        write_bits(&mut buf, 13, 6, 0b10_1101);
        assert_eq!(buf, [0, 0b1010_0000, 0b0000_0101, 0]);
    }

    /// A small deterministic generator for the coder tests.
    fn lcg(seed: u32) -> impl FnMut() -> u32 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            s >> 8
        }
    }

    #[test]
    fn arithmetic_coder_round_trips_skewed_and_even_bits() {
        for (seed, skew) in [(1u32, 2u32), (2, 16), (3, 200), (4, 1 << 23)] {
            let mut next = lcg(seed);
            let bits: Vec<bool> = (0..3000).map(|_| next() % skew == 0).collect();
            let mut enc = ArithEncoder::new();
            let mut m = BitModel::NEW;
            for (i, &b) in bits.iter().enumerate() {
                if i % 7 == 0 {
                    enc.encode_bypass(b);
                } else {
                    enc.encode(b, &mut m);
                }
            }
            let (bytes, nbits) = enc.finish();
            assert_eq!(bytes.len(), nbits.div_ceil(8));
            // The stream ends in a one: trailing zeros are left to the fill.
            if nbits > 0 {
                assert_eq!((bytes[(nbits - 1) / 8] >> ((nbits - 1) % 8)) & 1, 1);
            }
            let mut dec = ArithDecoder::new(&bytes, 0, nbits);
            let mut m = BitModel::NEW;
            for (i, &b) in bits.iter().enumerate() {
                let got = if i % 7 == 0 {
                    dec.decode_bypass()
                } else {
                    dec.decode(&mut m)
                };
                assert_eq!(got, b, "seed {seed}, bit {i}");
            }
            // An all-zero source codes to far less than a bit per decision.
            if skew == 1 << 23 {
                assert!(nbits < 3000 / 7 + 200, "{nbits} bits");
            }
        }
    }

    #[test]
    fn a_skewed_model_stays_inside_its_bounds() {
        let mut m = BitModel::NEW;
        for _ in 0..10_000 {
            m.update(false);
        }
        assert_eq!(m.0, 4081);
        for _ in 0..10_000 {
            m.update(true);
        }
        assert_eq!(m.0, 15);
        // The rate starts at one half and settles at 1/16 by the fourth bit.
        let mut up = BitModel::NEW;
        let mut steps = Vec::new();
        for _ in 0..5 {
            let before = up.0;
            up.update(false);
            steps.push(up.0 - before);
        }
        // 2048 → 3072 (½ of 2048), 3328 (¼ of 1024), 3424 (⅛ of 768), then
        // 1/16 of the remaining distance: 672 >> 4 = 42, 630 >> 4 = 39.
        assert_eq!(steps, [1024, 256, 96, 42, 39]);
        let mut down = BitModel::NEW;
        down.update(true);
        assert_eq!(down.0, 1024);
        // An even split after mixed bits: the counter saturates, it never
        // wraps back to the fast rate.
        let mut m = BitModel::NEW;
        for i in 0..1000 {
            m.update(i % 2 == 0);
        }
        assert_eq!(m.1, 3);
    }

    #[test]
    fn ac_models_round_trip_every_code_of_every_width() {
        let mut next = lcg(7);
        let fields: Vec<(usize, u32, u32)> = (0..4000)
            .map(|i| {
                let bits = 1 + next() % 6;
                let center = (1u32 << (bits - 1)) - 1;
                // Mostly near the centre, as AC codes are, with every code
                // of the width reachable.
                let q = if next() % 3 == 0 {
                    next() % (2 * center + 1)
                } else {
                    center
                };
                (i % 3, bits, q)
            })
            .collect();
        let mut enc = ArithEncoder::new();
        let mut models = AcModels::new();
        let mut hist = [AcHistory::default(); 3];
        for (i, &(g, bits, q)) in fields.iter().enumerate() {
            models.encode(&mut enc, &mut hist[g], g, i, bits, q);
        }
        let (bytes, nbits) = enc.finish();
        let mut dec = ArithDecoder::new(&bytes, 0, nbits);
        let mut models = AcModels::new();
        let mut hist = [AcHistory::default(); 3];
        for (i, &(g, bits, q)) in fields.iter().enumerate() {
            let want = if bits == 1 { 0 } else { q };
            assert_eq!(
                models.decode(&mut dec, &mut hist[g], g, i, bits),
                want,
                "field {i}"
            );
        }
    }

    /// The coded stream is a wire format: were the coder adopted, every
    /// language would have to emit these exact bits. A round trip cannot pin
    /// that — a coder whose constants moved (the interval's top, a quarter,
    /// the adaptation rate) still decodes its own output — so this holds the
    /// bytes of one fixed stream, and the stream of a single decision, as
    /// golden values.
    #[test]
    fn the_coded_stream_is_bit_exact() {
        let mut next = lcg(29);
        let mut enc = ArithEncoder::new();
        let mut models = AcModels::new();
        let mut hist = [AcHistory::default(); 3];
        for i in 0..120usize {
            let g = i % 3;
            let bits = [5u32, 4, 3][g];
            let center = (1u32 << (bits - 1)) - 1;
            let r = next();
            // Mostly zero, some small, a few at the edges of the range.
            let q = match r % 8 {
                0..=3 => center,
                4 | 5 => center + 1,
                6 => center - 1,
                _ => (r >> 3) % (2 * center + 1),
            };
            models.encode(&mut enc, &mut hist[g], g, i, bits, q);
        }
        let (bytes, nbits) = enc.finish();
        assert_eq!(nbits, GOLDEN_STREAM_BITS);
        assert_eq!(bytes, GOLDEN_STREAM);

        // One decision at even odds: the bit itself (renormalised out at
        // once), then the termination's `0` and its pending `1` — 1, 0, 1
        // for a one and 0, 0, 1 for a zero, least significant bit first.
        let mut one = ArithEncoder::new();
        one.encode_bypass(true);
        assert_eq!(one.finish(), (vec![0b101], 3));
        let mut zero = ArithEncoder::new();
        zero.encode_bypass(false);
        assert_eq!(zero.finish(), (vec![0b100], 3));
        // And an empty stream is the termination alone: 0 then 1.
        assert_eq!(ArithEncoder::new().finish(), (vec![0b10], 2));
        // With `low` at a quarter the termination is 1 then the pending 0,
        // and the strip drops that 0: one bit is left.
        let upper = ArithEncoder {
            low: QUARTER,
            ..ArithEncoder::new()
        };
        assert_eq!(upper.finish(), (vec![0b1], 1));
    }

    /// The bands are normative context labels, so their values are pinned,
    /// not only their partition: an offset band would relabel every context
    /// and still round-trip, until the cap merged two of them.
    #[test]
    fn bands_are_floor_log2_of_the_index_plus_one_capped_at_eleven() {
        let got: Vec<usize> = [0, 1, 2, 3, 6, 7, 2046, 2047, 4094, 4095, 6655]
            .iter()
            .map(|&i| ac_band(i))
            .collect();
        assert_eq!(got, [0, 1, 1, 2, 2, 3, 10, 11, 11, 11, 11]);
        // History context: how many of the last two codes were significant.
        let mut h = AcHistory::default();
        let mut seen = Vec::new();
        for s in [true, false, true, true, false, false] {
            h.push(s);
            seen.push(h.context());
        }
        assert_eq!(seen, [1, 1, 1, 2, 1, 0]);
    }

    /// A value exactly on the split belongs to the zero branch `[low,
    /// split]`. Random streams almost never land on it in 32 bits, so this
    /// reads one that does: the first 32 bits, most significant first, are
    /// `0x7FFF_FFFF`, the first even-odds split (`0 + 2^31 − 1`).
    #[test]
    fn a_value_on_the_split_decodes_as_zero() {
        // Bit 0 of the stream is 0, bits 1..=31 are 1 (each byte LSB first).
        let data = [0xFEu8, 0xFF, 0xFF, 0xFF];
        assert!(!ArithDecoder::new(&data, 0, 32).decode_bypass());
        // One above it is the one branch.
        let data = [0x01u8, 0x00, 0x00, 0x00];
        assert!(ArithDecoder::new(&data, 0, 32).decode_bypass());
    }

    /// The renormalisation's boundaries, on states built to land on them: a
    /// decision that leaves `high` exactly at a half, or exactly at three
    /// quarters with `low` at a quarter. Neither ever arises by chance in 32
    /// bits, and each is where `<` and `<=` part. Encoder and decoder are
    /// checked from the same state.
    #[test]
    fn renormalisation_takes_each_boundary_the_documented_way() {
        let encoder = |low: u64, high: u64| ArithEncoder {
            low,
            high,
            pending: 0,
            out: Vec::new(),
            nbits: 0,
        };
        let decoder = |low: u64, high: u64| ArithDecoder {
            data: &[],
            pos: 0,
            end: 0,
            low,
            high,
            value: low,
        };
        // [Q, 3Q + 1] at even odds splits at exactly a half. The zero branch
        // ends there: `high < HALF` is false, so it is the underflow case,
        // not an emitted zero.
        let (low, high) = (QUARTER, THREE_QUARTERS + 1);
        let mut e = encoder(low, high);
        e.encode_p(false, 2048);
        assert_eq!((e.low, e.high, e.pending, e.nbits), (0, HALF + 1, 1, 0));
        let mut d = decoder(low, high);
        assert!(!d.decode_p(2048));
        assert_eq!((d.low, d.high), (0, HALF + 1));

        // [Q, Q + 2863311531] at P(0) = 3/4 splits at exactly three
        // quarters: `high < 3Q` is false, so nothing renormalises.
        let (low, high) = (QUARTER, QUARTER + 2_863_311_531);
        let mut e = encoder(low, high);
        e.encode_p(false, 3072);
        assert_eq!(
            (e.low, e.high, e.pending, e.nbits),
            (QUARTER, THREE_QUARTERS, 0, 0)
        );
        let mut d = decoder(low, high);
        assert!(!d.decode_p(3072));
        assert_eq!((d.low, d.high), (QUARTER, THREE_QUARTERS));
    }

    const GOLDEN_STREAM_BITS: usize = 305;
    const GOLDEN_STREAM: [u8; 39] = [
        88, 75, 12, 105, 141, 43, 60, 172, 254, 195, 136, 104, 131, 132, 230, 2, 179, 221, 92, 196,
        124, 81, 134, 222, 197, 116, 186, 145, 239, 242, 27, 231, 186, 109, 14, 2, 197, 45, 1,
    ];

    #[test]
    fn the_decoder_is_total_over_arbitrary_bits() {
        // Any bytes, any window into them: every decoded code is in range and
        // nothing panics — the property D1's validity design rests on.
        let mut next = lcg(11);
        for trial in 0..200 {
            let len = (next() % 64) as usize;
            let data: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            let start = if len == 0 {
                0
            } else {
                (next() as usize) % (8 * len)
            };
            let mut dec = ArithDecoder::new(&data, start, 8 * len);
            let mut models = AcModels::new();
            let mut hist = AcHistory::default();
            for i in 0..500 {
                let bits = 1 + (i as u32 + trial) % 6;
                let q = models.decode(&mut dec, &mut hist, i % 3, i, bits);
                assert!(q <= (1u32 << bits) - 2, "code {q} at width {bits}");
            }
        }
        // Bits past `end` read as zero even where the bytes hold ones.
        let ones = [0xFFu8; 8];
        let mut a = ArithDecoder::new(&ones, 0, 0);
        let zeros = [0u8; 8];
        let mut b = ArithDecoder::new(&zeros, 0, 64);
        for _ in 0..64 {
            assert_eq!(a.decode_bypass(), b.decode_bypass());
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
