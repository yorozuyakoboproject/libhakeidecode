import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface DsiOptions {
  polarity: 'active-low' | 'active-high';
}

type DsiState = 'IDLE' | 'PHASE0' | 'PHASE1';
type BitRecord = readonly [ss: bigint, value: number];
type Interval = readonly [ss: bigint, es: bigint];

export function dsiLevel(value: number): number {
  return Math.trunc(value / 2.55);
}

export class DsiDecoder extends Decoder<DsiOptions> {
  static descriptor = descriptor;
  private samplerate: number | null = null;
  private halfbit = 0;
  private outAnn = -1;
  private edges: bigint[] = [];
  private bits: BitRecord[] = [];
  private bitIntervals: Interval[] = [];
  private state: DsiState = 'IDLE';
  private oldDsi = 1;
  private phase0 = 0;

  constructor(options: Partial<DsiOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.halfbit = 0;
    this.edges = [];
    this.bits = [];
    this.bitIntervals = [];
    this.state = 'IDLE';
    this.phase0 = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.oldDsi = 1;
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.halfbit = Math.trunc((value * 0.0016667) / 2);
  }

  private resetFrame(): void {
    this.edges = [];
    this.bits = [];
    this.bitIntervals = [];
    this.state = 'IDLE';
  }

  private annotateBits(from: number, to: number, classIndex: number, texts: readonly string[]): void {
    const first = this.bitIntervals[from]!,
      last = this.bitIntervals[to]!;
    this.put(first[0], last[1], this.outAnn, [classIndex, texts]);
  }

  private handleBits(length: number): void {
    for (let index = 0; index < length; index++) {
      const ss = index === 0 ? this.bits[0]![0] : this.bitIntervals[index - 1]![1];
      const es = this.bits[index]![0] + BigInt(this.halfbit * 2);
      this.bitIntervals.push([ss, es]);
      this.put(ss, es, this.outAnn, [0, [String(this.bits[index]![1])]]);
    }

    const startValue = this.bits[0]![1];
    const startTexts = [`Startbit: ${startValue}`, `ST: ${startValue}`, 'ST', 'S', 'S'] as const;
    this.annotateBits(0, 0, 1, startTexts);
    this.annotateBits(0, 0, 3, startTexts);

    if (length !== 9) return;
    let value = 0;
    for (let index = 0; index < 8; index++) value |= this.bits[1 + index]![1] << (7 - index);
    const level = dsiLevel(value);
    const hex = value.toString(16).toUpperCase().padStart(2, '0');
    this.annotateBits(1, 8, 3, [`Data: ${hex}`, `Dat: ${hex}`, `Dat: ${hex}`, `D: ${hex}`, 'D']);
    this.annotateBits(1, 8, 2, [`Level: ${level}%`, `Lev: ${level}%`, `Lev: ${level}%`, `L: ${level}`, 'D']);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      const pins = yield this.wait();
      let dsi = Number(pins[0]);
      if (this.options.polarity === 'active-high') dsi ^= 1;

      if (this.state === 'IDLE') {
        if (this.oldDsi === dsi) continue;
        this.edges.push(this.samplenum - BigInt(this.halfbit), this.samplenum);
        this.phase0 = dsi ^ 1;
        this.state = 'PHASE1';
        this.oldDsi = dsi;
        continue;
      }

      if (this.oldDsi !== dsi) {
        this.edges.push(this.samplenum);
      } else if (
        this.edges.length > 0 &&
        this.samplenum === this.edges.at(-1)! + BigInt(Math.trunc(this.halfbit * 1.5))
      ) {
        this.edges.push(this.samplenum - BigInt(Math.trunc(this.halfbit * 0.5)));
      } else {
        continue;
      }

      const bit = this.oldDsi;
      if (this.state === 'PHASE0') {
        this.phase0 = bit;
        this.state = 'PHASE1';
      } else if (this.state === 'PHASE1') {
        if (bit === 1 && this.phase0 === 1) {
          if (this.bits.length === 17 || this.bits.length === 9) this.handleBits(this.bits.length);
          this.resetFrame();
          continue;
        }
        this.bits.push([this.edges.at(-3)!, bit]);
        this.state = 'PHASE0';
      }
      this.oldDsi = dsi;
    }
  }
}

export default DsiDecoder;
