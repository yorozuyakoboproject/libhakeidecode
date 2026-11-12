import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext, LogicGenerator, WaitCondition } from '../../libhakeidecode/index.js';
import { bitpack_msb } from '../common.js';
import { descriptor } from './descriptor.js';

export interface FlexRayOptions {
  channel_type: 'A' | 'B';
  bitrate: number;
}

const CRC_INIT_A = 0xfedcba;
const CRC_INIT_B = 0xabcdef;
const CRC_POLYNOMIAL = 0x5d6dcb;
const HEADER_CRC_INIT = 0x01a;
const HEADER_CRC_POLYNOMIAL = 0x385;
const CHANNEL_IDLE_DELIMITER = 11;

function crcBits(bits: readonly number[], polynomial: number, width: number, initial = 0): number {
  const mask = (1 << width) - 1;
  let register = initial & mask;
  for (const bit of bits) {
    const feedback = ((register >>> (width - 1)) & 1) ^ bit;
    register = (register << 1) & mask;
    if (feedback) register ^= polynomial;
  }
  return register & mask;
}

export class FlexRayDecoder extends Decoder<FlexRayOptions> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private bitWidth = 0;
  private samplePoint = 0;
  private state: 'IDLE' | 'GET BITS' = 'IDLE';
  private tssStart = 0n;
  private tssEnd = 0n;
  private rawBits: number[] = [];
  private bits: number[] = [];
  private curbit = 0;
  private lastDatabit = 999;
  private lastXmitBit = 999;
  private ssBlock: bigint | null = null;
  private ssDatabyteBits: bigint[] = [];
  private endOfFrame = false;
  private dynamicFrame = false;
  private ssBit0: bigint | null = null;
  private ssBit1: bigint | null = null;
  private ssBit2: bigint | null = null;
  private payloadLength = 0;
  private frameId = 0;
  private frameCrc = 0;
  private domEdgeSnum = 0n;
  private domEdgeBCount = 0;
  private outAnn = -1;

  constructor(options: Partial<FlexRayOptions> = {}) {
    super(options);
    this.resetState();
  }

  override reset(): void {
    this.resetState();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    const bitrate = Number(this.options.bitrate);
    if (!(bitrate > 0)) throw new RangeError('Invalid FlexRay bitrate.');
    this.bitWidth = value / bitrate;
    this.samplePoint = (this.bitWidth * 50) / 100;
  }

  private resetState(): void {
    this.state = 'IDLE';
    this.tssStart = 0n;
    this.tssEnd = 0n;
    this.rawBits = [];
    this.bits = [];
    this.curbit = 0;
    this.lastDatabit = 999;
    this.lastXmitBit = 999;
    this.ssBlock = null;
    this.ssDatabyteBits = [];
    this.endOfFrame = false;
    this.dynamicFrame = false;
    this.ssBit0 = null;
    this.ssBit1 = null;
    this.ssBit2 = null;
    this.payloadLength = 0;
    this.frameId = 0;
    this.frameCrc = 0;
    this.domEdgeSnum = 0n;
    this.domEdgeBCount = 0;
  }

  private putG(ss: bigint, es: bigint, data: AnnotationData): void {
    const left = BigInt(Math.trunc(this.samplePoint));
    const right = BigInt(Math.trunc(this.bitWidth - this.samplePoint));
    this.put(ss - left, es + right, this.outAnn, data);
  }

  private putX(data: AnnotationData): void {
    this.putG(this.samplenum, this.samplenum, data);
  }

  private putB(data: AnnotationData): void {
    if (this.ssBlock !== null) this.putG(this.ssBlock, this.samplenum, data);
  }

  private domEdgeSeen(): void {
    this.domEdgeSnum = this.samplenum;
    this.domEdgeBCount = this.curbit;
  }

  private samplePointFor(bitnum: number): bigint {
    return this.domEdgeSnum + BigInt(Math.trunc(this.bitWidth * (bitnum - this.domEdgeBCount) + this.samplePoint));
  }

  private isBssSequence(): boolean {
    if (this.endOfFrame) return false;
    return (this.rawBits.length - 2) % 10 === 0 || (this.rawBits.length - 3) % 10 === 0;
  }

  private handleBit(frRx: number): void {
    this.rawBits.push(frRx);
    this.bits.push(frRx);
    const bitnum = this.bits.length - 1;

    if (this.isBssSequence()) {
      this.bits.pop();
      if (bitnum > 1) this.putX([15, [String(frRx)]]);
      else if (this.rawBits.length === 2) this.ssBit1 = this.samplenum;
      else if (this.rawBits.length === 3) this.ssBit2 = this.samplenum;
      this.curbit++;
      return;
    }
    if (bitnum > 1) this.putX([17, [String(frRx)]]);

    if (bitnum === 0) {
      this.ssBit0 = this.samplenum;
    } else if (bitnum === 1) {
      if (this.rawBits.slice(0, 3).join('') === '110') {
        this.put(this.tssStart, this.tssEnd, this.outAnn, [1, ['Transmission start sequence', 'TSS']]);
        if (this.ssBit0 !== null) this.putG(this.ssBit0, this.ssBit0, [17, [String(this.rawBits[0])]]);
        if (this.ssBit0 !== null) this.putG(this.ssBit0, this.ssBit0, [2, ['FSS', 'Frame start sequence']]);
        if (this.ssBit1 !== null) this.putG(this.ssBit1, this.ssBit1, [15, [String(this.rawBits[1])]]);
        if (this.ssBit2 !== null) this.putG(this.ssBit2, this.ssBit2, [15, [String(this.rawBits[2])]]);
        this.putX([17, [String(frRx)]]);
        this.putX([3, [`Reserved bit: ${frRx}`, `RB: ${frRx}`, 'RB']]);
      } else {
        this.put(this.tssStart, this.tssEnd, this.outAnn, [20, ['Collision avoidance symbol', 'CAS']]);
        this.resetState();
      }
    } else if (bitnum === 2) {
      this.putX([4, [`Payload preamble indicator: ${frRx}`, `PPI: ${frRx}`]]);
    } else if (bitnum === 3) {
      const frameType = frRx ? 'data frame' : 'null frame';
      this.putX([5, [`Null frame indicator: ${frameType}`, `NF: ${frRx}`, 'NF']]);
    } else if (bitnum === 4) {
      this.putX([6, [`Sync frame indicator: ${frRx}`, `Sync: ${frRx}`, 'Sync']]);
    } else if (bitnum === 5) {
      this.putX([7, [`Startup frame indicator: ${frRx}`, `Startup: ${frRx}`, 'Startup']]);
    } else if (bitnum === 6) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === 16) {
      this.frameId = bitpack_msb(this.bits.slice(6));
      this.putB([8, [`Frame ID: ${this.frameId}`, `ID: ${this.frameId}`, String(this.frameId)]]);
    } else if (bitnum === 17) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === 23) {
      this.payloadLength = bitpack_msb(this.bits.slice(17));
      this.putB([
        9,
        [`Payload length: ${this.payloadLength}`, `Length: ${this.payloadLength}`, String(this.payloadLength)],
      ]);
    } else if (bitnum === 24) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === 34) {
      const headerBits = this.bits.slice(4, 24);
      const expected = crcBits(headerBits, HEADER_CRC_POLYNOMIAL, 11, HEADER_CRC_INIT);
      const headerCrc = bitpack_msb(this.bits.slice(24));
      const status = headerCrc === expected ? 'OK' : 'bad';
      this.putB([
        10,
        [
          `Header CRC: 0x${headerCrc.toString(16).toUpperCase()} (${status})`,
          `0x${headerCrc.toString(16).toUpperCase()} (${status})`,
          `0x${headerCrc.toString(16).toUpperCase()}`,
        ],
      ]);
    } else if (bitnum === 35) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === 40) {
      const cycle = bitpack_msb(this.bits.slice(35));
      this.putB([11, [`Cycle: ${cycle}`, `Cyc: ${cycle}`, String(cycle)]]);
      this.lastDatabit = 41 + 2 * this.payloadLength * 8;
    } else if (bitnum >= 41 && bitnum < this.lastDatabit) {
      this.ssDatabyteBits.push(this.samplenum);
    } else if (bitnum === this.lastDatabit) {
      this.ssDatabyteBits.push(this.samplenum);
      for (let index = 0; index < 2 * this.payloadLength; index++) {
        const offset = 40 + 8 * index + 1;
        const value = bitpack_msb(this.bits.slice(offset, offset + 8));
        const ss = this.ssDatabyteBits[index * 8]!;
        const es = this.ssDatabyteBits[(index + 1) * 8 - 1]!;
        this.putG(ss, es, [
          12,
          [
            `Data byte ${index}: 0x${value.toString(16).padStart(2, '0')}`,
            `DB${index}: 0x${value.toString(16).padStart(2, '0')}`,
            value.toString(16).padStart(2, '0').toUpperCase(),
          ],
        ]);
      }
      this.ssDatabyteBits = [];
      this.ssBlock = this.samplenum;
    } else if (bitnum === this.lastDatabit + 23) {
      const bits = this.bits.slice(1, this.bits.length - 24);
      const initial = this.options.channel_type === 'A' ? CRC_INIT_A : CRC_INIT_B;
      const expected = crcBits(bits, CRC_POLYNOMIAL, 24, initial);
      this.frameCrc = bitpack_msb(this.bits.slice(this.lastDatabit));
      const status = this.frameCrc === expected ? 'OK' : 'bad';
      this.putB([
        13,
        [
          `Frame CRC: 0x${this.frameCrc.toString(16).toUpperCase()} (${status})`,
          `0x${this.frameCrc.toString(16).toUpperCase()} (${status})`,
          `0x${this.frameCrc.toString(16).toUpperCase()}`,
        ],
      ]);
      this.endOfFrame = true;
    } else if (bitnum === this.lastDatabit + 24) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === this.lastDatabit + 25) {
      this.putB([14, ['Frame end sequence', 'FES']]);
    } else if (bitnum === this.lastDatabit + 26) {
      if (frRx === 0) this.dynamicFrame = true;
      else this.lastXmitBit = bitnum;
      this.ssBlock = this.samplenum;
    } else if (bitnum === this.lastXmitBit) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === this.lastXmitBit + CHANNEL_IDLE_DELIMITER - 1) {
      this.putB([18, ['Channel idle delimiter', 'CID']]);
      this.resetState();
    } else if (bitnum > this.lastDatabit + 27 && this.dynamicFrame && frRx === 1) {
      if (this.lastXmitBit === 999) {
        this.putB([19, ['Dynamic trailing sequence', 'DTS']]);
        this.lastXmitBit = bitnum + 1;
        this.ssBlock = this.samplenum;
      }
    }
    this.curbit++;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      if (this.state === 'IDLE') {
        yield this.wait({ 0: 'l' });
        this.tssStart = this.samplenum;
        yield this.wait({ 0: 'h' });
        this.tssEnd = this.samplenum;
        this.domEdgeSeen();
        this.state = 'GET BITS';
        continue;
      }
      const position = this.samplePointFor(this.curbit);
      const conditions: WaitCondition[] = [{ skip: position - this.samplenum }, { 0: 'f' }];
      const pins = yield this.wait(conditions);
      if (this.matched?.[1]) this.domEdgeSeen();
      if (this.matched?.[0]) this.handleBit(pins[0]!);
    }
  }
}

export default FlexRayDecoder;
export { FlexRayDecoder as FlexrayDecoder };
