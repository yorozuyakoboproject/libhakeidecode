import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface Ps2Bit {
  readonly value: number;
  readonly ss: bigint;
  es: bigint;
}

export class Ps2Decoder extends Decoder {
  static descriptor = descriptor;
  private outAnn = -1;
  private bits: Ps2Bit[] = [];

  override reset(): void {
    this.bits = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private handleBit(value: number): void {
    if (!this.bits.length && value === 1) return;
    this.bits.push({ value, ss: this.samplenum, es: this.samplenum });
    if (this.bits.length > 1) this.bits[this.bits.length - 2]!.es = this.samplenum;
    if (this.bits.length < 12) return;

    const period = this.bits[2]!.ss - this.bits[1]!.ss;
    const halfPeriod = (period + 1n) / 2n;
    this.bits[10]!.es += halfPeriod;

    let word = 0;
    for (let index = 0; index < 8; index++) word |= this.bits[index + 1]!.value << index;
    let ones = 0;
    for (let index = 0; index < 8; index++) ones += (word >>> index) & 1;
    const parityOk = (ones + this.bits[9]!.value) % 2 === 1;

    for (const bit of this.bits.slice(0, 11)) this.put(bit.ss, bit.es, this.outAnn, [0, [String(bit.value)]]);
    this.put(this.bits[0]!.ss, this.bits[0]!.es, this.outAnn, [1, ['Start bit', 'Start', 'S']]);
    this.put(this.bits[1]!.ss, this.bits[8]!.es, this.outAnn, [
      6,
      [
        `Data: ${word.toString(16).padStart(2, '0')}`,
        `D: ${word.toString(16).padStart(2, '0')}`,
        word.toString(16).padStart(2, '0'),
      ],
    ]);
    this.put(
      this.bits[9]!.ss,
      this.bits[9]!.es,
      this.outAnn,
      parityOk ? [3, ['Parity OK', 'Par OK', 'P']] : [4, ['Parity error', 'Par err', 'PE']],
    );
    this.put(this.bits[10]!.ss, this.bits[10]!.es, this.outAnn, [2, ['Stop bit', 'Stop', 'St', 'T']]);
    this.bits = [];
  }

  *decode(): LogicGenerator {
    while (true) {
      let pins = yield this.wait({ clk: 'f' });
      this.handleBit(Number(pins[1]));
      if (this.bits.length !== 11) continue;
      pins = yield this.wait({ clk: 'r' });
      this.handleBit(Number(pins[1]));
    }
  }
}

export default Ps2Decoder;
