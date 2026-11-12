import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

interface SPIWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly mosi: number | null;
  readonly miso: number | null;
  readonly cs: boolean | null;
}

const REGISTERS: Readonly<Record<number, readonly [string, number]>> = {
  0x01: ['AWATTHR', 16],
  0x02: ['BWATTHR', 16],
  0x03: ['CWATTHR', 16],
  0x04: ['AVARHR', 16],
  0x05: ['BVARHR', 16],
  0x06: ['CVARHR', 16],
  0x07: ['AVAHR', 16],
  0x08: ['BVAHR', 16],
  0x09: ['CVAHR', 16],
  0x0a: ['AIRMS', 24],
  0x0b: ['BIRMS', 24],
  0x0c: ['CIRMS', 24],
  0x0d: ['AVRMS', 24],
  0x0e: ['BVRMS', 24],
  0x0f: ['CVRMS', 24],
  0x10: ['FREQ', 12],
  0x11: ['TEMP', 8],
  0x12: ['WFORM', 24],
  0x13: ['OPMODE', 8],
  0x14: ['MMODE', 8],
  0x15: ['WAVMODE', 8],
  0x16: ['COMPMODE', 8],
  0x17: ['LCYCMODE', 8],
  0x18: ['Mask', 24],
  0x19: ['Status', 24],
  0x1a: ['RSTATUS', 24],
  0x1b: ['ZXTOUT', 16],
  0x1c: ['LINECYC', 16],
  0x1d: ['SAGCYC', 8],
  0x1e: ['SAGLVL', 8],
  0x1f: ['VPINTLVL', 8],
  0x20: ['IPINTLVL', 8],
  0x21: ['VPEAK', 8],
  0x22: ['IPEAK', 8],
  0x23: ['Gain', 8],
  0x24: ['AVRMSGAIN', 12],
  0x25: ['BVRMSGAIN', 12],
  0x26: ['CVRMSGAIN', 12],
  0x27: ['AIGAIN', 12],
  0x28: ['BIGAIN', 12],
  0x29: ['CIGAIN', 12],
  0x2a: ['AWG', 12],
  0x2b: ['BWG', 12],
  0x2c: ['CWG', 12],
  0x2d: ['AVARG', 12],
  0x2e: ['BVARG', 12],
  0x2f: ['CVARG', 12],
  0x30: ['AVAG', 12],
  0x31: ['BVAG', 12],
  0x32: ['CVAG', 12],
  0x33: ['AVRMSOS', 12],
  0x34: ['BVRMSOS', 12],
  0x35: ['CVRMSOS', 12],
  0x36: ['AIRMSOS', 12],
  0x37: ['BIRMSOS', 12],
  0x38: ['CIRMSOS', 12],
  0x39: ['AWATTOS', 12],
  0x3a: ['BWATTOS', 12],
  0x3b: ['CWATTOS', 12],
  0x3c: ['AVAROS', 12],
  0x3d: ['BVAROS', 12],
  0x3e: ['CVAROS', 12],
  0x3f: ['APHCAL', 7],
  0x40: ['BPHCAL', 7],
  0x41: ['CPHCAL', 7],
  0x42: ['WDIV', 8],
  0x43: ['VARDIV', 8],
  0x44: ['VADIV', 8],
  0x45: ['APCFNUM', 16],
  0x46: ['APCFDEN', 12],
  0x47: ['VARCFNUM', 16],
  0x48: ['VARCFDEN', 12],
  0x7e: ['CHKSUM', 8],
  0x7f: ['Version', 8],
};

function wordBytes(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  for (let remainder = value; remainder > 0; remainder = Math.floor(remainder / 256)) bytes.unshift(remainder & 0xff);
  return bytes;
}

function spiWord(ss: bigint, es: bigint, data: unknown): SPIWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const mosi = data[1],
    miso = data[2],
    cs = data[3];
  for (const value of [mosi, miso])
    if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, mosi, miso, cs };
}

function bytesToNumber(bytes: readonly number[]): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

export class Ade77xxDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private mosiBytes: number[] = [];
  private misoBytes: number[] = [];
  private ssCmd: bigint | null = null;
  private lastEs: bigint | null = null;
  private minimumGap: bigint | null = null;

  override reset(): void {
    this.mosiBytes = [];
    this.misoBytes = [];
    this.ssCmd = null;
    this.lastEs = null;
    this.minimumGap = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private resetData(): void {
    this.mosiBytes = [];
    this.misoBytes = [];
    this.ssCmd = null;
  }

  private putAnnotation(classIndex: number, text: string, ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [classIndex, [text]]);
  }

  private finishPending(es: bigint): void {
    if (this.mosiBytes.length < 2 || this.ssCmd === null) {
      this.resetData();
      return;
    }
    const command = this.mosiBytes[0]!,
      register = command & 0x7f,
      info = REGISTERS[register],
      payload = this.mosiBytes.length - 1;
    if (info) {
      const expected = Math.ceil(info[1] / 8);
      if (payload > 0 && payload < expected) {
        this.putAnnotation(command & 0x80 ? 1 : 0, `${info[0]}: SHORT`, this.ssCmd, es);
        this.putAnnotation(2, 'Short transfer!', this.ssCmd, es);
      }
    }
    this.resetData();
  }

  private addBytes(mosi: number[], miso: number[], ss: bigint, es: bigint): void {
    const count = Math.max(mosi.length, miso.length),
      mosiOffset = count - mosi.length,
      misoOffset = count - miso.length;
    for (let index = 0; index < count; index++) {
      if (!this.mosiBytes.length) this.ssCmd = ss;
      this.mosiBytes.push(mosi[index - mosiOffset] ?? 0);
      this.misoBytes.push(miso[index - misoOffset] ?? 0);
      if (this.mosiBytes.length < 2) continue;
      const command = this.mosiBytes[0]!,
        write = (command & 0x80) !== 0,
        register = command & 0x7f,
        info = REGISTERS[register];
      if (!info) {
        this.putAnnotation(2, 'Unknown register!', this.ssCmd!, es);
        continue;
      }
      const expected = Math.ceil(info[1] / 8),
        payload = this.mosiBytes.length - 1;
      if (payload !== expected) continue;
      const bytes = write ? this.mosiBytes.slice(1, expected + 1) : this.misoBytes.slice(1, expected + 1),
        value = bytesToNumber(bytes);
      this.putAnnotation(write ? 1 : 0, `${info[0]}: 0x${value.toString(16)}`, this.ssCmd!, es);
      this.resetData();
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING' && typeof data[1] === 'string') {
      if (data[1].startsWith('Chip select deasserted')) this.finishPending(this.samplenum);
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word || word.mosi === null) return;
    if (this.lastEs !== null) {
      const gap = ss - this.lastEs;
      if (gap > 0n) {
        if (this.minimumGap === null || gap < this.minimumGap) this.minimumGap = gap;
        else if (gap > this.minimumGap * 2n) this.finishPending(this.lastEs);
      }
    }
    if (word.cs === false) this.finishPending(es);
    this.addBytes(wordBytes(word.mosi), word.miso === null ? [] : wordBytes(word.miso), ss, es);
    this.lastEs = es;
  }

  onEof(): void {
    this.finishPending(this.lastEs ?? this.samplenum);
  }
}

export default Ade77xxDecoder;
