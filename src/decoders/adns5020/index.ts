import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const ANN = Object.freeze({ READ: 0, WRITE: 1, WARNING: 2 });

const REGISTERS: Readonly<Record<number, string>> = {
  0x00: 'Product_ID',
  0x01: 'Revision_ID',
  0x02: 'Motion',
  0x03: 'Delta_X',
  0x04: 'Delta_Y',
  0x05: 'SQUAL',
  0x06: 'Shutter_Upper',
  0x07: 'Shutter_Lower',
  0x08: 'Maximum_Pixel',
  0x09: 'Pixel_Sum',
  0x0a: 'Minimum_Pixel',
  0x0b: 'Pixel_Grab',
  0x0d: 'Mouse_Control',
  0x3a: 'Chip_Reset',
  0x3f: 'Inv_Rev_ID',
  0x63: 'Motion_Burst',
};

interface WireByte {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

function wordWidth(value: number | null): number {
  if (value === null || value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

export class Adns5020Decoder extends Decoder {
  static descriptor = descriptor;
  private outAnn = -1;
  private pending: WireByte[] = [];
  private commandStart: bigint | null = null;
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;
  private previousCs: boolean | null = null;

  override reset(): void {
    this.pending = [];
    this.commandStart = null;
    this.lastWordEnd = null;
    this.lastWordSpan = 0n;
    this.previousCs = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private warn(ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [ANN.WARNING, ['Misplaced CS#!']]);
  }

  private endTransaction(end: bigint): void {
    if (this.pending.length !== 0 && this.pending.length !== 2) {
      const start = this.commandStart ?? end,
        finish = end > start ? end : start;
      this.warn(start, finish);
    }
    this.pending = [];
    this.commandStart = null;
  }

  private registerName(register: number): string {
    if (register > 0x63) return 'Unknown';
    return REGISTERS[register] ?? `Reserved 0x${register.toString(16)}`;
  }

  private emitCommand(): void {
    const command = this.pending[0]!,
      argument = this.pending[1]!,
      write = (command.value & 0x80) !== 0,
      register = command.value & 0x7f,
      name = this.registerName(register),
      text = write ? `${name}: 0x${argument.value.toString(16)}` : `${name}: ${argument.value.toString(10)}`;
    this.put(command.ss, argument.es, this.outAnn, [write ? ANN.WRITE : ANN.READ, [text]]);
    this.pending = [];
    this.commandStart = null;
  }

  private consume(bytes: readonly WireByte[]): void {
    for (const byte of bytes) {
      if (!this.pending.length) this.commandStart = byte.ss;
      this.pending.push(byte);
      if (this.pending.length === 2) this.emitCommand();
    }
  }

  private split(ss: bigint, es: bigint, mosi: number): WireByte[] {
    const count = wordWidth(mosi),
      span = es - ss,
      first = mosi;
    return Array.from({ length: count }, (_, index) => ({
      value: Math.floor(first / 2 ** (8 * (count - index - 1))) & 0xff,
      ss: ss + (span * BigInt(index)) / BigInt(count),
      es: ss + (span * BigInt(index + 1)) / BigInt(count),
    }));
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    if (data[0] === 'WARNING') return;
    if (data[0] !== 'WORD') return;

    const mosi = typeof data[1] === 'number' ? data[1] : null,
      cs = typeof data[3] === 'boolean' ? data[3] : null;
    if (mosi === null) return;

    if (cs === false) {
      this.endTransaction(ss);
      this.previousCs = false;
      this.lastWordEnd = es;
      this.lastWordSpan = es > ss ? es - ss : 0n;
      return;
    }
    if (cs === true && this.previousCs === false) this.endTransaction(ss);
    if (this.pending.length && this.lastWordEnd !== null && ss - this.lastWordEnd > this.lastWordSpan)
      this.endTransaction(this.lastWordEnd);

    this.consume(this.split(ss, es, mosi));
    this.previousCs = cs;
    this.lastWordEnd = es;
    this.lastWordSpan = es > ss ? es - ss : 0n;
  }
}

export default Adns5020Decoder;
