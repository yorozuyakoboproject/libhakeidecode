import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

interface SPIWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly miso: number | null;
  readonly cs: boolean | null;
}

const MODES = [
    ['Normal Mode', 'Normal', 'Norm', 'N'],
    ['Power Down Mode', 'Power Down', 'PD'],
    ['Power Up Mode', 'Power Up', 'PU'],
  ],
  VALIDATION = {
    invalid: ['Invalid data', 'Invalid', 'N/A'],
    incomplete: ['Incomplete conversion', 'Incomplete', 'I'],
    complete: ['Complete conversion', 'Complete', 'C'],
  };

function wordBytes(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  for (let remainder = value; remainder > 0; remainder = Math.floor(remainder / 256)) bytes.unshift(remainder & 0xff);
  return bytes;
}

function spiWord(ss: bigint, es: bigint, data: unknown): SPIWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const miso = data[2],
    cs = data[3];
  if (miso !== null && (typeof miso !== 'number' || !Number.isInteger(miso) || miso < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, miso, cs };
}

export class Ad79x0Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private value = 0;
  private bits = 0;
  private ss: bigint | null = null;
  private lastEs: bigint | null = null;
  private minimumGap: bigint | null = null;

  override reset(): void {
    this.value = 0;
    this.bits = 0;
    this.ss = null;
    this.lastEs = null;
    this.minimumGap = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private decodeFrame(value: number, bits: number, ss: bigint, es: bigint): void {
    if (bits < 10) {
      this.put(ss, es, this.outAnn, [0, MODES[1]]);
      this.put(ss, es, this.outAnn, [2, VALIDATION.invalid]);
      return;
    }
    if (value === 0xfff) {
      this.put(ss, es, this.outAnn, [0, MODES[2]]);
      this.put(ss, es, this.outAnn, [2, VALIDATION.invalid]);
      return;
    }
    this.put(ss, es, this.outAnn, [0, MODES[0]]);
    this.put(ss, es, this.outAnn, [2, bits === 16 ? VALIDATION.complete : VALIDATION.incomplete]);
    const voltage = (value / 4095) * Number(this.options.vref);
    this.put(ss, es, this.outAnn, [1, [voltage.toFixed(6) + 'V', voltage.toFixed(2) + 'V']]);
  }

  private finishPending(es: bigint, discarded = 0): void {
    if (!this.bits) return;
    const value = this.value * 2 ** discarded,
      bits = this.bits + discarded;
    this.decodeFrame(value, bits, this.ss ?? es, es);
    this.value = 0;
    this.bits = 0;
    this.ss = null;
  }

  private addByte(byte: number, ss: bigint, es: bigint): void {
    if (!this.bits) this.ss = ss;
    this.value = this.value * 256 + byte;
    this.bits += 8;
    while (this.bits >= 16) {
      const surplus = this.bits - 16,
        frameValue = Math.floor(this.value / 2 ** surplus);
      this.decodeFrame(frameValue, 16, this.ss ?? ss, es);
      this.value %= 2 ** surplus;
      this.bits = surplus;
      this.ss = surplus ? ss : null;
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      const match = /Chip select deasserted: (\d+) bit\(s\) discarded/.exec(data[1]);
      if (match) this.finishPending(this.samplenum, Number(match[1]));
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word) return;
    if (this.lastEs !== null) {
      const gap = ss - this.lastEs;
      if (gap > 0n) {
        if (this.minimumGap === null || gap < this.minimumGap) this.minimumGap = gap;
        else if (gap > this.minimumGap * 2n) this.finishPending(this.lastEs);
      }
    }
    if (word.cs === false) this.finishPending(es);
    if (word.miso !== null) for (const byte of wordBytes(word.miso)) this.addByte(byte, ss, es);
    this.lastEs = es;
  }

  onEof(): void {
    this.finishPending(this.lastEs ?? this.samplenum);
  }
}

export default Ad79x0Decoder;
