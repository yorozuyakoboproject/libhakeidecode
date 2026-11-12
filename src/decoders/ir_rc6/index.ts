import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins, WaitConditions } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface Rc6Options {
  polarity: 'auto' | 'active-low' | 'active-high';
}

export interface Rc6Frame {
  readonly mode: 0 | 6;
  readonly address: number;
  readonly data: number;
  readonly toggle: 0 | 1;
  readonly shortAddress?: boolean;
}

export function rc6HalfBit(sampleRate: number): number {
  return Math.trunc((sampleRate * 0.000889) / 2);
}

export function rc6FrameBits(frame: Rc6Frame): number[] {
  if (frame.mode === 0) {
    if (!Number.isInteger(frame.address) || frame.address < 0 || frame.address > 0xff)
      throw new RangeError('RC-6 address must be eight bits.');
    if (!Number.isInteger(frame.data) || frame.data < 0 || frame.data > 0xff)
      throw new RangeError('RC-6 data must be eight bits.');
    return [1, 0, 0, 0, frame.toggle, ...highBits(frame.address, 8), ...highBits(frame.data, 8)];
  }
  if (frame.shortAddress ?? true) {
    if (!Number.isInteger(frame.address) || frame.address < 0 || frame.address > 0x7f)
      throw new RangeError('RC-6 short address must be seven bits.');
    if (!Number.isInteger(frame.data) || frame.data < 0 || frame.data > 1)
      throw new RangeError('RC-6 short-frame data must be one bit.');
    return [1, 1, 1, 0, frame.toggle, ...highBits(frame.address, 8), frame.data & 1];
  }
  if (!Number.isInteger(frame.address) || frame.address < 0x8000 || frame.address > 0xffff)
    throw new RangeError('RC-6 long address must start with a one bit.');
  if (!Number.isInteger(frame.data) || frame.data < 0 || frame.data > 1)
    throw new RangeError('RC-6 long-frame data must be one bit.');
  return [1, 1, 1, 0, frame.toggle, ...highBits(frame.address, 16), frame.data & 1];
}

function highBits(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (value >> (count - index - 1)) & 1);
}

function formatHex(value: number, minimumDigits = 2): string {
  return value.toString(16).toUpperCase().padStart(minimumDigits, '0');
}

type Rc6Bit = readonly [ss: bigint, es: bigint, duration: number, value: number];

export class IrRc6Decoder extends Decoder<Rc6Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private halfbit = 0;
  private edges: bigint[] = [];
  private deltas: number[] = [];
  private bits: Rc6Bit[] = [];
  private state = 'IDLE';
  private mode = 0;
  private invert = false;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.halfbit = rc6HalfBit(value);
  }

  override reset(): void {
    this.halfbit = 0;
    this.edges = [];
    this.deltas = [];
    this.bits = [];
    this.state = 'IDLE';
    this.mode = 0;
    this.invert = false;
  }

  *decode(): LogicGenerator {
    if (!this.halfbit) throw new Error('Cannot decode without samplerate.');
    let value = 0;
    let numEdges = -1;
    this.invert = false;

    while (true) {
      const conditions: WaitConditions =
        this.state === 'DATA' ? [{ ir: 'e' }, { skip: this.halfbit * 6 }] : { ir: 'e' };
      const pins: Pins = yield this.wait(conditions);
      const ir = Number(pins[0]);
      if (this.state === 'DATA' && this.matched?.[1]) this.state = 'IDLE';

      this.edges.push(this.samplenum);
      if (this.edges.length < 2) continue;

      const previous = this.edges.at(-2)!;
      const delta = Math.trunc(Number(this.samplenum - previous) / this.halfbit + 0.5);
      this.deltas.push(delta);
      if (this.deltas.length < 2) continue;

      if (this.deltas.at(-2) === 6 && this.deltas.at(-1) === 2) {
        this.state = 'SYNC';
        numEdges = 0;
        this.bits = [];
        value = this.options.polarity === 'auto' ? 1 : this.options.polarity === 'active-high' ? ir : 1 - ir;
        this.bits.push([this.edges.at(-3)!, this.edges.at(-1)!, 8, value]);
        this.invert = ir === 0;
        this.putBit(this.bits.at(-1)!, [0, [String(value)]]);
      }

      if (numEdges % 2 === 0) {
        const firstDelta = this.deltas.at(-2)!;
        const secondDelta = this.deltas.at(-1)!;
        if ([1, 2, 3].includes(firstDelta) && [1, 2, 3, 6].includes(secondDelta)) {
          this.state = 'DATA';
          if (firstDelta !== secondDelta) {
            this.edges.splice(this.edges.length - 1, 0, this.edges.at(-2)! + BigInt(firstDelta * this.halfbit));
            this.deltas[this.deltas.length - 1] = firstDelta;
            this.deltas.push(secondDelta - firstDelta);
            this.bits.push([this.edges.at(-4)!, this.edges.at(-2)!, firstDelta * 2, value]);
            numEdges++;
          } else {
            this.bits.push([this.edges.at(-3)!, this.edges.at(-1)!, secondDelta * 2, value]);
          }
          this.putBit(this.bits.at(-1)!, [0, [String(value)]]);
        }
      }

      if (this.bits.length > 0) {
        this.handleBit();
        if (this.state === 'IDLE') this.handlePackage();
      }

      if (this.options.polarity === 'auto') value = this.invert ? ir : 1 - ir;
      else value = this.options.polarity === 'active-low' ? ir : 1 - ir;
      numEdges++;
    }
  }

  private putBit(bit: Rc6Bit, data: readonly [number, readonly string[]]): void {
    this.put(bit[0], bit[1], this.outAnn, data);
  }

  private putBits(first: Rc6Bit, second: Rc6Bit, data: readonly [number, readonly string[]]): void {
    this.put(first[0], second[1], this.outAnn, data);
  }

  private handleBit(): void {
    if (this.bits.length !== 6) return;
    if (this.bits[0]![2] !== 8 || this.bits[0]![3] !== 1) return;
    this.putBit(this.bits[0]!, [1, ['Synchronisation', 'Sync']]);
    if (this.bits[1]![3] !== 1) return;
    this.putBit(this.bits[1]!, [2, ['Startbit', 'Start']]);
    this.mode = 0;
    for (let index = 0; index < 3; index++) this.mode |= this.bits[2 + index]![3] << (2 - index);
    this.putBits(this.bits[2]!, this.bits[4]!, [3, [`Field: ${this.mode}`]]);
    this.putBit(this.bits[5]!, [4, [`Toggle: ${this.bits[5]![3]}`]]);
  }

  private handlePackage(): void {
    if (this.bits[0]![3] === 0 || this.bits[1]![3] === 0) return;
    if (this.bits.length <= 6) return;

    if (this.mode === 0 && this.bits.length === 22) {
      let value = 0;
      for (let index = 0; index < 8; index++) value |= this.bits[6 + index]![3] << (7 - index);
      this.putBits(this.bits[6]!, this.bits[13]!, [5, [`Address: ${formatHex(value)}`]]);
      value = 0;
      for (let index = 0; index < 8; index++) value |= this.bits[14 + index]![3] << (7 - index);
      this.putBits(this.bits[14]!, this.bits[21]!, [6, [`Data: ${formatHex(value)}`]]);
      this.bits = [];
      return;
    }

    if (this.mode !== 6 || this.bits.length < 15) return;
    if (this.bits[6]![3] === 0) {
      let value = 0;
      for (let index = 0; index < 8; index++) value |= this.bits[6 + index]![3] << (7 - index);
      this.putBits(this.bits[6]!, this.bits[13]!, [5, [`Address: ${formatHex(value)}`]]);
      const dataBits = this.bits.length - 14;
      value = 0;
      for (let index = 0; index < dataBits; index++) value |= this.bits[14 + index]![3] << (dataBits - index - 1);
      this.putBits(this.bits[14]!, this.bits.at(-1)!, [6, [`Data: ${value.toString(16).toUpperCase()}`]]);
      this.bits = [];
      return;
    }

    if (this.bits.length < 23) return;
    let value = 0;
    for (let index = 0; index < 16; index++) value |= this.bits[6 + index]![3] << (15 - index);
    this.putBits(this.bits[6]!, this.bits[21]!, [5, [`Address: ${formatHex(value)}`]]);
    const dataBits = this.bits.length - 22;
    value = 0;
    for (let index = 0; index < dataBits; index++) value |= this.bits[22 + index]![3] << (dataBits - index - 1);
    this.putBits(this.bits[22]!, this.bits.at(-1)!, [6, [`Data: ${value.toString(16).toUpperCase()}`]]);
    this.bits = [];
  }
}

export default IrRc6Decoder;
