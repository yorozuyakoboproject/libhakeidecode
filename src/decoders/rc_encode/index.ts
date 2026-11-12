import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface RcEncodeOptions {
  linecoding: 'SC52x2/HX22x2' | 'xx1527';
  remote: 'none' | 'maplin_l95ar';
}

export const RC_BIT_VALUES = ['0', '1', 'f', 'U'] as const;
export type RcBit = (typeof RC_BIT_VALUES)[number];
export interface RcBitRecord {
  readonly value: RcBit;
  readonly ss: bigint;
  readonly es: bigint;
}

export function decodeBit(edges: readonly number[], pulsesPerBit: number): RcBit {
  if (pulsesPerBit === 2) {
    if (edges[1]! >= edges[0]! * 1.5 && edges[1]! <= edges[0]! * 5) return '0';
    if (edges[0]! >= edges[1]! * 1.5 && edges[0]! <= edges[1]! * 5) return '1';
    return 'U';
  }
  if (pulsesPerBit === 4) {
    if (
      edges[1]! >= edges[0]! * 2 &&
      edges[1]! <= edges[0]! * 5 &&
      edges[2]! >= edges[0]! * 0.5 &&
      edges[2]! <= edges[0]! * 1.5 &&
      edges[3]! >= edges[0]! * 2 &&
      edges[3]! <= edges[0]! * 5
    )
      return '0';
    if (
      edges[0]! >= edges[1]! * 2 &&
      edges[0]! <= edges[1]! * 5 &&
      edges[0]! >= edges[2]! * 0.5 &&
      edges[0]! <= edges[2]! * 1.5 &&
      edges[0]! >= edges[3]! * 2 &&
      edges[0]! <= edges[3]! * 5
    )
      return '1';
    if (
      edges[1]! >= edges[0]! * 2 &&
      edges[1]! <= edges[0]! * 5 &&
      edges[2]! >= edges[0]! * 2 &&
      edges[2]! <= edges[0]! * 5 &&
      edges[3]! >= edges[0]! * 0.5 &&
      edges[3]! <= edges[0]! * 1.5
    )
      return 'f';
    return 'U';
  }
  throw new RangeError('Unsupported RC pulse count.');
}

export function pinLabel(bitCount: number, packetBits: number): string | undefined {
  if (packetBits === 12) {
    if (bitCount <= 6) return `A${bitCount - 1}`;
    return `A${bitCount - 1}/D${12 - bitCount}`;
  }
  if (packetBits === 24) {
    if (bitCount <= 20) return `A${bitCount - 1}`;
    return `D${bitCount - 21}`;
  }
  return undefined;
}

export function decodeModel(
  model: string,
  bits: readonly RcBitRecord[],
): [address: string, addrStart: bigint, addrEnd: bigint, data: string, dataStart: bigint, dataEnd: bigint] | null {
  if (model === 'maplin_l95ar') {
    let address = 'Addr';
    for (let index = 0; index < 6; index++) address += ` ${index + 1}:${bits[index]!.value === '0' ? 'on' : 'off'}`;
    let button = 'Button';
    if (bits[6]!.value === '0' && bits[11]!.value === '0') button += ' A ON/OFF';
    else if (bits[7]!.value === '0' && bits[11]!.value === '0') button += ' B ON/OFF';
    else if (bits[9]!.value === '0' && bits[11]!.value === '0') button += ' C ON/OFF';
    else if (bits[8]!.value === '0' && bits[11]!.value === '0') button += ' D ON/OFF';
    else button += ' Unknown';
    return [address, bits[0]!.ss, bits[5]!.es, button, bits[6]!.ss, bits[11]!.es];
  }
  if (model === 'xx1527') {
    let address = 0;
    let valid = true;
    for (let index = 0; index < 20; index++) {
      const bit = bits[index]!.value;
      if (bit === 'U') valid = false;
      else address += Number(bit) * 2 ** index;
    }
    const addressText = valid
      ? `Address 0x${(address >> 16).toString(16).toUpperCase()} ${((address >> 8) & 0xff)
          .toString(16)
          .toUpperCase()} ${(address & 0xff).toString(16).toUpperCase()}`
      : 'Invalid address as not all bits are 0 or 1';
    const output = ` K0 = ${bits[20]!.value}, K1 = ${bits[21]!.value}, K2 = ${bits[22]!.value}, K3 = ${bits[23]!.value}`;
    return [addressText, bits[0]!.ss, bits[19]!.es, output, bits[20]!.ss, bits[23]!.es];
  }
  return null;
}

export class RcEncodeDecoder extends Decoder<RcEncodeOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private samplenumberLast: bigint | null = null;
  private pulses: number[] = [];
  private bits: RcBitRecord[] = [];
  private bitCount = 0;
  private ss: bigint | null = null;
  private es: bigint | null = null;
  private state = 'IDLE';
  private pulsesPerBit = 4;
  private packetBits = 12;
  private model = 'none';

  constructor(options: Partial<RcEncodeOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplenumberLast = null;
    this.pulses = [];
    this.bits = [];
    this.bitCount = 0;
    this.ss = null;
    this.es = null;
    this.state = 'IDLE';
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.model = this.options.remote;
    if (this.options.linecoding === 'xx1527') {
      this.pulsesPerBit = 2;
      this.packetBits = 24;
      this.model = 'xx1527';
    } else {
      this.pulsesPerBit = 4;
      this.packetBits = 12;
    }
  }

  *decode(): LogicGenerator {
    while (true) {
      yield this.wait({ data: 'e' });
      this.state = 'DECODING';

      if (this.samplenumberLast === null || this.samplenumberLast === 0n) {
        this.samplenumberLast = this.samplenum;
        this.ss = this.samplenum;
        continue;
      }

      if (this.bitCount < this.packetBits) {
        this.bitCount++;
        for (let index = 0; index < this.pulsesPerBit; index++) {
          if (index > 0) yield this.wait({ data: 'e' });
          const samples = Number(this.samplenum - this.samplenumberLast);
          this.pulses.push(samples);
          this.samplenumberLast = this.samplenum;
        }
        this.es = this.samplenum;
        const value = decodeBit(this.pulses, this.pulsesPerBit);
        this.bits.push({ value, ss: this.ss!, es: this.es });
        this.put(this.ss!, this.es, this.outAnn, [RC_BIT_VALUES.indexOf(value), [value]]);
        this.put(this.ss!, this.es, this.outAnn, [5, [pinLabel(this.bitCount, this.packetBits)!]]);
        this.pulses = [];
        this.ss = this.samplenum;
      } else {
        if (this.model !== 'none') {
          const labels = decodeModel(this.model, this.bits);
          if (labels) {
            this.put(labels[1], labels[2], this.outAnn, [6, [labels[0]]]);
            this.put(labels[4], labels[5], this.outAnn, [7, [labels[3]]]);
          }
        }
        const samples = Number(this.samplenum - this.samplenumberLast);
        yield this.wait({ skip: 8 * samples });
        this.es = this.samplenum;
        this.put(this.ss!, this.es, this.outAnn, [4, ['Sync']]);
        this.reset();
        this.state = 'DECODE_TIMEOUT';
      }
      if (this.state !== 'DECODE_TIMEOUT') this.samplenumberLast = this.samplenum;
    }
  }
}

export default RcEncodeDecoder;
