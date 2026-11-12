import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface SdaBit {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

const ANN = Object.freeze({
  CMD_BIT: 0,
  DATA_BIT: 1,
  COMMAND: 2,
  FIELD: 3,
});

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export class Sda2506Decoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private cmdBits: SdaBit[] = [];
  private dataBits: SdaBit[] = [];
  private dataStart = 0n;

  constructor() {
    super();
    this.reset();
  }

  override reset(): void {
    this.cmdBits = [];
    this.dataBits = [];
    this.dataStart = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private decodeBits(offset: number, width: number): number {
    let value = 0;
    for (let index = 0; index < width; index++) value = (value << 1) | this.cmdBits[offset + index]!.value;
    return value;
  }

  private field(name: string, offset: number, width: number): number {
    const bits = this.cmdBits.slice(offset, offset + width);
    let ss = bits[0]!.ss,
      es = bits[0]!.es;
    for (const bit of bits) {
      if (bit.ss < ss) ss = bit.ss;
      if (bit.es > es) es = bit.es;
    }
    const value = this.decodeBits(offset, width);
    this.put(ss, es, this.outAnn, [ANN.FIELD, [`${name}: ${hex(value)}`]]);
    return value;
  }

  private putDataByte(): void {
    let value = 0;
    for (const bit of this.dataBits) value = (value << 1) | bit.value;
    this.put(this.dataStart, this.samplenum, this.outAnn, [ANN.FIELD, [hex(value)]]);
    this.dataBits = [];
  }

  private *handleChipEnable(data: number): LogicGenerator {
    if (this.cmdBits.length < 8) {
      this.cmdBits = [];
      this.dataBits = [];
      return;
    }

    const address = this.field('addr', 1, 7);
    this.field('CB', 0, 1);
    if (this.cmdBits[0]!.value === 0) {
      this.field('read', 1, 7);
      this.put(this.cmdBits[7]!.es, this.samplenum, this.outAnn, [ANN.COMMAND, ['read']]);
    } else if (data === 0 && this.cmdBits.length >= 16) {
      const value = this.field('data', 8, 8),
        start = this.samplenum;
      yield this.wait({ ce: 'r' });
      this.put(start, this.samplenum, this.outAnn, [ANN.COMMAND, [`Write to ${hex(address)}: ${hex(value)}`]]);
    } else if (data === 1) {
      const start = this.samplenum;
      yield this.wait({ ce: 'r' });
      this.put(start, this.samplenum, this.outAnn, [ANN.COMMAND, [`Erase: ${hex(address)}`]]);
    } else {
      this.cmdBits = [];
    }
    this.dataBits = [];
  }

  *decode(): LogicGenerator {
    if (!this.hasChannel('clk') || !this.hasChannel('d') || !this.hasChannel('ce'))
      throw new Error('CLK, DATA and CE# channels are required.');
    while (true) {
      const pins = yield this.wait([{ clk: 'e' }, { ce: 'e' }]),
        clk = Number(pins[0]),
        data = Number(pins[1]),
        ce = Number(pins[2]);
      if (this.matched?.[0] && ce === 1 && clk === 1) {
        const ss = this.samplenum;
        yield this.wait({ clk: 'f' });
        const es = this.samplenum;
        this.cmdBits.unshift({ value: data, ss, es });
        if (this.cmdBits.length > 24) this.cmdBits.pop();
        this.put(ss, es, this.outAnn, [ANN.CMD_BIT, [String(data)]]);
      } else if (this.matched?.[0] && ce === 0 && clk === 0) {
        const ss = this.samplenum,
          next = yield this.wait([{ clk: 'r' }, { ce: 'e' }]),
          value = Number(next[1]),
          es = this.samplenum;
        if (!this.dataBits.length) this.dataStart = ss;
        this.dataBits.unshift({ value, ss, es });
        this.put(ss, es, this.outAnn, [ANN.DATA_BIT, [String(value)]]);
        if (this.dataBits.length === 8) this.putDataByte();
      } else if (this.matched?.[1] && ce === 0) {
        yield* this.handleChipEnable(data);
      }
    }
  }
}

export default Sda2506Decoder;
