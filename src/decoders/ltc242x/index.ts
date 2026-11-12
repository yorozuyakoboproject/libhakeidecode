import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface Ltc242xOptions {
  vref: number;
}

interface SpiWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly miso: number | null;
}

function spiWord(ss: bigint, es: bigint, data: unknown): SpiWord | null {
  if (!Array.isArray(data) || data[0] !== 'WORD') return null;
  const miso = data[2];
  if (miso !== null && (typeof miso !== 'number' || !Number.isInteger(miso) || miso < 0)) return null;
  return { ss, es, miso };
}

export class Ltc242xDecoder extends Decoder<Ltc242xOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private words: number[] = [];
  private frameSs: bigint | null = null;
  private frameEs: bigint | null = null;
  private lastEs: bigint | null = null;
  private lastDuration: bigint | null = null;

  override reset(): void {
    this.words = [];
    this.frameSs = null;
    this.frameEs = null;
    this.lastEs = null;
    this.lastDuration = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.reset();
  }

  private emitFrame(es: bigint): void {
    if (!this.words.length || this.frameSs === null) return;
    let value = 0;
    if (this.words.length === 1) {
      value = this.words[0]! & 0xffffff;
    } else {
      for (const word of this.words) value = value * 256 + (word & 0xff);
    }
    const raw = value & 0x3fffff;
    const signed = raw - 0x200000;
    const voltage = (signed / 0xfffff) * this.options.vref;
    const channel = (value >> 22) & 1;
    this.put(this.frameSs, es, this.outAnn, [channel, [`${voltage.toFixed(6)}V`, `${voltage.toFixed(2)}V`]]);
    this.words = [];
    this.frameSs = null;
    this.frameEs = null;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING') {
      this.emitFrame(this.samplenum);
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.miso === null) return;

    if (this.words.length && this.lastEs !== null && this.lastDuration !== null) {
      const gap = ss - this.lastEs;
      if (gap > this.lastDuration) this.emitFrame(this.lastEs);
    }

    this.frameSs ??= ss;
    this.frameEs = es;
    this.words.push(word.miso);
    this.lastEs = es;
    this.lastDuration = es - ss;
  }

  onEof(): void {
    this.emitFrame(this.frameEs ?? this.samplenum);
  }
}

export default Ltc242xDecoder;
