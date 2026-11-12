import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

type Bit = readonly [signal: number, ss: bigint, es: bigint];
const HEADER = 0,
  PROPORTIONAL = 1,
  DIGITAL = 2,
  FRAME_LOST = 3,
  FOOTER = 5,
  WARN = 6;
const FLAG_NAMES = ['framelost', 'failsafe', 'msb'] as const;

export class SbusFutabaDecoder extends Decoder<{
  prop_val_min: number;
  prop_val_max: number;
}> {
  static descriptor = descriptor;
  private outAnn = -1;
  private outProtocol = -1;
  private bits: Bit[] = [];
  private sentFields = 0;
  private messageComplete = false;
  private failed: readonly string[] | null = null;

  override reset(): void {
    this.bits = [];
    this.sentFields = 0;
    this.messageComplete = false;
    this.failed = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private protocol(ss: bigint, es: bigint, data: unknown): void {
    this.put(ss, es, this.outProtocol, data);
  }

  private takeBits(count: number | null): { ss: bigint; es: bigint; bits: number[] } | null {
    const length = count ?? this.bits.length;
    if (this.bits.length < length) return null;
    const selected = this.bits.slice(0, length);
    this.bits = this.bits.slice(length);
    return {
      ss: selected[0]![1],
      es: selected[selected.length - 1]![2],
      bits: selected.map((bit) => Number(bit[0]) & 1),
    };
  }

  private value(bits: readonly number[]): number {
    return bits.reduce((value, bit, index) => value + bit * 2 ** index, 0);
  }

  private flushBits(): void {
    if (this.failed) return;
    let upto = 1;
    let want = 8;
    while (this.sentFields < upto) {
      const field = this.takeBits(want);
      if (!field) return;
      const value = this.value(field.bits);
      this.annotate(field.ss, field.es, HEADER, [`0x${value.toString(16).padStart(2, '0')}`]);
      if (value !== 0x0f) this.annotate(field.ss, field.es, WARN, ['Unexpected header', 'Header']);
      this.protocol(field.ss, field.es, ['HEADER', value]);
      this.sentFields++;
    }

    upto += 16;
    want = 11;
    while (this.sentFields < upto) {
      const field = this.takeBits(want);
      if (!field) return;
      const value = this.value(field.bits);
      this.annotate(field.ss, field.es, PROPORTIONAL, [String(value)]);
      if (value < this.options.prop_val_min)
        this.annotate(field.ss, field.es, WARN, ['Low proportional value', 'Low value', 'Low']);
      if (value > this.options.prop_val_max)
        this.annotate(field.ss, field.es, WARN, ['High proportional value', 'High value', 'High']);
      this.protocol(field.ss, field.es, ['PROPORTIONAL', [1 + this.sentFields - 1, value]]);
      this.sentFields++;
    }

    upto += 2;
    want = 1;
    while (this.sentFields < upto) {
      const field = this.takeBits(want);
      if (!field) return;
      const value = this.value(field.bits);
      this.annotate(field.ss, field.es, DIGITAL, [String(value)]);
      this.protocol(field.ss, field.es, ['DIGITAL', [17 + this.sentFields - 17, value]]);
      this.sentFields++;
    }

    upto += 2;
    want = 1;
    while (this.sentFields < upto) {
      const field = this.takeBits(want);
      if (!field) return;
      const value = this.value(field.bits);
      const index = this.sentFields - 19;
      this.annotate(field.ss, field.es, FRAME_LOST + index, [String(value)]);
      this.protocol(field.ss, field.es, ['FLAG', [FLAG_NAMES[index], value]]);
      this.sentFields++;
    }

    upto += 1;
    want = 4;
    while (this.sentFields < upto) {
      const field = this.takeBits(want);
      if (!field) return;
      const value = this.value(field.bits);
      if (value !== 0) this.annotate(field.ss, field.es, WARN, ['Unexpected MSB flags', 'Flags']);
      this.protocol(field.ss, field.es, ['FLAG', ['msb', value]]);
      this.sentFields++;
    }

    upto += 1;
    want = 8;
    while (this.sentFields < upto) {
      const field = this.takeBits(want);
      if (!field) return;
      const value = this.value(field.bits);
      this.annotate(field.ss, field.es, FOOTER, [`0x${value.toString(16).padStart(2, '0')}`]);
      if (value !== 0) this.annotate(field.ss, field.es, WARN, ['Unexpected footer', 'Footer']);
      this.protocol(field.ss, field.es, ['FOOTER', value]);
      this.sentFields++;
    }

    if (this.sentFields >= upto) this.messageComplete = true;
    if (this.messageComplete && this.bits.length) this.failed = ['Excess data bits', 'Excess'];
  }

  private handleIdle(): void {
    if (this.bits.length && !this.failed) this.failed = ['Unprocessed data bits', 'Unprocessed'];
    if (this.bits.length && this.failed) {
      const field = this.takeBits(null);
      if (field) this.annotate(field.ss, field.es, WARN, this.failed);
    }
    this.reset();
  }

  private handleBreak(ss: bigint, es: bigint): void {
    if (!this.failed) this.failed = ['BREAK condition', 'Break'];
    this.handleIdle();
    this.annotate(ss, es, WARN, ['BREAK condition', 'Break']);
    this.reset();
  }

  decode(_ss: bigint, _es: bigint, data: unknown): void {
    const [packetType, , payload] = data as [string, number, unknown];
    if (packetType === 'DATA') {
      this.bits.push(...(payload as [number, Bit[]])[1]);
    } else if (packetType === 'FRAME') {
      const valid = (payload as [number, boolean | null])[1];
      if (!valid) this.failed = ['Invalid data', 'Invalid'];
      this.flushBits();
    } else if (packetType === 'IDLE') {
      this.handleIdle();
    } else if (packetType === 'BREAK') {
      this.handleBreak(_ss, _es);
    }
  }
}

export default SbusFutabaDecoder;
