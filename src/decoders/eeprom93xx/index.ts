import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface MicrowirePacketBit {
  readonly ss: bigint;
  readonly es: bigint;
  readonly si: number;
  readonly so: number;
}

interface Eeprom93xxOptions {
  addresssize: number;
  wordsize: number;
  format: string;
}

type UnknownPacket = readonly unknown[];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBigInt(value: unknown, fallback: bigint): bigint {
  return typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? BigInt(value)
      : fallback;
}

function packetBit(value: unknown, fallbackSs: bigint, fallbackEs: bigint): MicrowirePacketBit | null {
  if (Array.isArray(value)) {
    if (value.length < 4) return null;
    return {
      ss: toBigInt(value[0], fallbackSs),
      es: toBigInt(value[1], fallbackEs),
      si: Number(value[2]) & 1,
      so: Number(value[3]) & 1,
    };
  }
  if (!isRecord(value)) return null;
  const si = value.si,
    so = value.so;
  if (typeof si !== 'number' || typeof so !== 'number') return null;
  return {
    ss: toBigInt(value.ss, fallbackSs),
    es: toBigInt(value.es, fallbackEs),
    si: si & 1,
    so: so & 1,
  };
}

function normalizePacket(data: unknown, ss: bigint, es: bigint): MicrowirePacketBit[] {
  if (!Array.isArray(data)) return [];
  const source = data as UnknownPacket;
  if (!source.length) return [];
  const bits = source.map((item) => packetBit(item, ss, es));
  if (bits.some((item) => item === null)) return [];
  return bits as MicrowirePacketBit[];
}

function hexWord(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

export class Eeprom93xxDecoder extends Decoder<Eeprom93xxOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;

  constructor(options: Partial<Eeprom93xxOptions> = {}) {
    super(options);
    this.validateOptions();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.validateOptions();
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  private validateOptions(): void {
    if (!Number.isInteger(this.options.addresssize) || this.options.addresssize < 1 || this.options.addresssize > 31)
      throw new Error('Address size must be 1..31 bits.');
    if (!Number.isInteger(this.options.wordsize) || this.options.wordsize < 1 || this.options.wordsize > 64)
      throw new Error('Word size must be 1..64 bits.');
    if (this.options.format !== 'ascii' && this.options.format !== 'hex')
      throw new Error('Data format must be ascii or hex.');
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warn(ss: bigint, es: bigint, text: string): void {
    this.annotate(ss, es, 2, [text]);
  }

  private putAddress(bits: readonly MicrowirePacketBit[]): number {
    let address = 0;
    for (const bit of bits) address = (address << 1) | bit.si;
    const width = Math.max(4, Math.ceil(this.options.addresssize / 4));
    this.annotate(bits[0]!.ss, bits.at(-1)!.es, 0, [
      `Address: 0x${hexWord(address, width)}`,
      `Addr: 0x${hexWord(address, width)}`,
      `0x${hexWord(address, width)}`,
    ]);
    const byteWidth = Math.max(1, Math.ceil(this.options.addresssize / 8));
    const bytes = Uint8Array.from(
      { length: byteWidth },
      (_, index) => (address >>> (8 * (byteWidth - index - 1))) & 0xff,
    );
    this.put(bits[0]!.ss, bits.at(-1)!.es, this.outBinary, [0, bytes]);
    return address;
  }

  private putWord(si: boolean, bits: readonly MicrowirePacketBit[]): number {
    let word = 0n;
    for (const bit of bits) word = (word << 1n) | BigInt(si ? bit.si : bit.so);
    const ss = bits[0]!.ss,
      es = bits.at(-1)!.es;
    if (this.options.format === 'ascii') {
      let text = '';
      for (let shift = 0; shift < bits.length; shift += 8) {
        const value = Number((word >> BigInt(shift)) & 0xffn);
        text =
          (value >= 32 && value <= 126
            ? String.fromCharCode(value)
            : `[${value.toString(16).toUpperCase().padStart(2, '0')}]`) + text;
      }
      this.annotate(ss, es, si ? 0 : 1, [`Data: ${text}`, text]);
      return Number(word);
    }
    const digits = Math.max(4, Math.ceil(this.options.wordsize / 4));
    this.annotate(ss, es, si ? 0 : 1, [
      `Data: 0x${hexWord(Number(word), digits)}`,
      `0x${hexWord(Number(word), digits)}`,
    ]);
    this.put(ss, es, this.outBinary, [1, Uint8Array.of(Number((word >> 8n) & 0xffn), Number(word & 0xffn))]);
    return Number(word);
  }

  private command(bits: readonly MicrowirePacketBit[], classIndex: number, texts: readonly string[], end = 1): void {
    this.annotate(bits[0]!.ss, bits[end]!.es, classIndex, texts);
  }

  private decodeRead(data: readonly MicrowirePacketBit[]): void {
    this.command(data, 0, ['Read word', 'READ']);
    this.putAddress(data.slice(2, 2 + this.options.addresssize));
    let offset = 2 + this.options.addresssize;
    while (offset < data.length) {
      if (data.length - offset < this.options.wordsize) {
        this.warn(data[offset]!.ss, data.at(-1)!.es, 'Not enough word bits');
        return;
      }
      this.putWord(false, data.slice(offset, offset + this.options.wordsize));
      offset += this.options.wordsize;
    }
  }

  private decodeWrite(data: readonly MicrowirePacketBit[]): void {
    this.command(data, 0, ['Write word', 'WRITE']);
    this.putAddress(data.slice(2, 2 + this.options.addresssize));
    const offset = 2 + this.options.addresssize;
    if (data.length - offset < this.options.wordsize)
      this.warn((data[offset] ?? data.at(-1))!.ss, data.at(-1)!.es, 'Not enough word bits');
    else this.putWord(true, data.slice(offset, offset + this.options.wordsize));
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const bits = normalizePacket(data, this.samplenum, es);
    if (!bits.length) {
      this.warn(this.samplenum, es, 'Not enough packet bits');
      return;
    }
    if (bits.length < 2 + this.options.addresssize) {
      this.warn(ss, es, 'Not enough packet bits');
      return;
    }
    const opcode = (bits[0]!.si << 1) | bits[1]!.si;
    if (opcode === 2) this.decodeRead(bits);
    else if (opcode === 1) this.decodeWrite(bits);
    else if (opcode === 3) {
      this.command(bits, 0, ['Erase word', 'ERASE']);
      this.putAddress(bits.slice(2, 2 + this.options.addresssize));
    } else {
      if (bits.length < 4) {
        this.warn(ss, es, 'Not enough packet bits');
        return;
      }
      const operation = ((bits[2]?.si ?? 0) << 1) | (bits[3]?.si ?? 0);
      const commandBits = 2 + this.options.addresssize;
      if (bits.length < commandBits) {
        this.warn(bits[0]!.ss, bits.at(-1)!.es, 'Not enough packet bits');
        return;
      }
      const names = ['Write disable', 'Write all memory', 'Erase all memory', 'Write enable'] as const;
      const terse = ['WDS', 'WRAL', 'ERAL', 'WEN'] as const;
      const texts =
        operation === 1
          ? ['Write all memory', 'Write all', 'WRAL']
          : operation === 2
            ? ['Erase all memory', 'Erase all', 'ERAL']
            : [names[operation]!, terse[operation]!];
      this.command(bits, 0, texts, commandBits - 1);
      if (operation === 1) {
        const offset = commandBits;
        if (bits.length - offset < this.options.wordsize)
          this.warn((bits[offset] ?? bits.at(-1))!.ss, bits.at(-1)!.ss, 'Not enough word bits');
        else this.putWord(true, bits.slice(offset, offset + this.options.wordsize));
      }
    }
  }
}

export default Eeprom93xxDecoder;
