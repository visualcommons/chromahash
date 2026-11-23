/**
 * The arithmetic-coded AC stream's **decoder** (spec §3.6; register entry
 * D1): a port of `rust/src/bitpack.rs`' `ArithDecoder` and `AcModels`.
 *
 * Every quantity is an integer below 2^45, so plain `number` arithmetic is
 * exact; multiplication and `Math.floor` stand in for the shifts JavaScript
 * would truncate to 32 bits. The code is total: every bit at or past the end
 * of the stream reads as zero, and every decoded code is in range.
 */

const PROB_BITS = 12;
const PROB_ONE = 1 << PROB_BITS;
const ADAPT_SHIFT = 4;
const HALF = 2 ** 31;
const QUARTER = 2 ** 30;
const THREE_QUARTERS = 3 * 2 ** 30;
const TOP = 2 ** 32 - 1;

/** Channel groups with their own models: luma, chroma (a and b share), alpha. */
export const AC_GROUPS = 3;
const AC_BANDS = 12;
const MAG_BINS = 4;

/** One adaptive binary model: P(bit = 0) in 1/4096, and bits coded (≤ 3). */
interface BitModel {
  p0: number;
  n: number;
}

function newModel(): BitModel {
  return { p0: PROB_ONE >> 1, n: 0 };
}

function update(m: BitModel, bit: boolean): void {
  const shift = 1 + m.n;
  if (shift < ADAPT_SHIFT) m.n += 1;
  if (bit) m.p0 -= m.p0 >> shift;
  else m.p0 += (PROB_ONE - m.p0) >> shift;
}

/** Arithmetic decoder over the bit range `[start, end)` of `data`. */
export class ArithDecoder {
  private readonly data: Uint8Array;
  private pos: number;
  private readonly end: number;
  private low = 0;
  private high = TOP;
  private value = 0;

  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.pos = start;
    this.end = Math.min(end, data.length * 8);
    for (let i = 0; i < 32; i++) this.value = this.value * 2 + this.nextBit();
  }

  private nextBit(): number {
    const bit =
      this.pos < this.end
        ? ((this.data[this.pos >> 3] ?? 0) >> (this.pos & 7)) & 1
        : 0;
    this.pos += 1;
    return bit;
  }

  private decodeP(p0: number): boolean {
    const range = this.high - this.low + 1;
    const split = this.low + Math.floor((range * p0) / PROB_ONE) - 1;
    const bit = this.value > split;
    if (bit) this.low = split + 1;
    else this.high = split;
    for (let i = 0; i < 64; i++) {
      if (this.high < HALF) {
        // nothing to subtract
      } else if (this.low >= HALF) {
        this.low -= HALF;
        this.high -= HALF;
        this.value -= HALF;
      } else if (this.low >= QUARTER && this.high < THREE_QUARTERS) {
        this.low -= QUARTER;
        this.high -= QUARTER;
        this.value -= QUARTER;
      } else {
        break;
      }
      this.low *= 2;
      this.high = this.high * 2 + 1;
      this.value = this.value * 2 + this.nextBit();
    }
    return bit;
  }

  /** Decode one bit against `model`, then adapt it as the encoder did. */
  decode(model: BitModel): boolean {
    const bit = this.decodeP(model.p0);
    update(model, bit);
    return bit;
  }

  /** Decode one even-odds bit. */
  decodeBypass(): boolean {
    return this.decodeP(PROB_ONE >> 1);
  }
}

/** Per-channel history: the significance of the previous two codes. */
export class AcHistory {
  private bits = 0;
  context(): number {
    return (this.bits & 1) + ((this.bits >> 1) & 1);
  }
  push(significant: boolean): void {
    this.bits = ((this.bits << 1) | (significant ? 1 : 0)) & 3;
  }
}

/** `floor(log2(index + 1))`, capped at the last band. */
function acBand(index: number): number {
  return Math.min(31 - Math.clz32(index + 1), AC_BANDS - 1);
}

/** The adaptive models of one coded AC stream. */
export class AcModels {
  private readonly sig: BitModel[][][];
  private readonly mag: BitModel[][][];

  constructor() {
    const grid = (k: number): BitModel[][][] =>
      Array.from({ length: AC_GROUPS }, () =>
        Array.from({ length: AC_BANDS }, () =>
          Array.from({ length: k }, newModel),
        ),
      );
    this.sig = grid(3);
    this.mag = grid(MAG_BINS);
  }

  /**
   * Decode one AC code of a `bits`-wide field at selection `index`. Total:
   * it returns a code in `0..=2^bits − 2` for any input.
   */
  decode(
    dec: ArithDecoder,
    hist: AcHistory,
    group: number,
    index: number,
    bits: number,
  ): number {
    const center = (1 << (bits - 1)) - 1;
    if (center === 0) return 0;
    const band = acBand(index);
    const sig = this.sig[group]?.[band]?.[hist.context()];
    if (!sig) throw new Error("AC model index out of range");
    const significant = dec.decode(sig);
    hist.push(significant);
    if (!significant) return center;
    const negative = dec.decodeBypass();
    let mag = 1;
    for (let j = 0; j < center - 1; j++) {
      const m = this.mag[group]?.[band]?.[Math.min(j, MAG_BINS - 1)];
      if (!m) throw new Error("AC model index out of range");
      if (!dec.decode(m)) break;
      mag += 1;
    }
    return negative ? center - mag : center + mag;
  }
}
