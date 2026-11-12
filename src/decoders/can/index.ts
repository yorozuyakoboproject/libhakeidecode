import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { AnnotationData, DecoderContext, LogicGenerator, WaitCondition } from '../../libhakeidecode/index.js';
import { bitpack_msb } from '../common.js';
import { descriptor } from './descriptor.js';

export interface CanOptions {
  nominal_bitrate: number;
  fast_bitrate: number;
  sample_point: number;
}

export type CanFrameType = 'standard' | 'extended';
export type CanRtrType = 'data' | 'remote' | null;
export type CanProtocolPacket = [
  frameType: CanFrameType,
  fullId: number,
  rtrType: CanRtrType,
  dlc: number,
  bytes: number[],
];

function dlcToLength(dlc: number): number {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64][dlc] ?? 0;
}

export class CanDecoder extends Decoder<CanOptions> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private bitWidth = 0;
  private samplePoint = 0;
  private state: 'IDLE' | 'GET BITS' = 'IDLE';
  private rawBits: number[] = [];
  private bits: number[] = [];
  private curbit = 0;
  private lastDatabit = 999;
  private ssBlock: bigint | null = null;
  private ssBit12: bigint | null = null;
  private ssBit32: bigint | null = null;
  private ssDatabyteBits: bigint[] = [];
  private frameBytes: number[] = [];
  private frameType: CanFrameType | null = null;
  private fullId = 0;
  private ident = 0;
  private eid = 0;
  private dlc: number | null = null;
  private dlcStart = 0;
  private crcLen = 15;
  private rtrType: CanRtrType = null;
  private rtr: number | null = null;
  private fd = false;
  private ssPacket: bigint | null = null;
  private esPacket: bigint | null = null;
  private domEdgeSnum = 0n;
  private domEdgeBCount = 0;
  private outAnn = -1;
  private outProtocol = -1;

  constructor(options: Partial<CanOptions> = {}) {
    super(options);
    this.resetState();
  }

  override reset(): void {
    this.resetState();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]!);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.setNominalBitrate();
  }

  private resetState(): void {
    this.state = 'IDLE';
    this.rawBits = [];
    this.bits = [];
    this.curbit = 0;
    this.lastDatabit = 999;
    this.ssBlock = null;
    this.ssBit12 = null;
    this.ssBit32 = null;
    this.ssDatabyteBits = [];
    this.frameBytes = [];
    this.frameType = null;
    this.fullId = 0;
    this.ident = 0;
    this.eid = 0;
    this.dlc = null;
    this.dlcStart = 0;
    this.crcLen = 15;
    this.rtrType = null;
    this.rtr = null;
    this.fd = false;
    this.ssPacket = null;
    this.esPacket = null;
    this.domEdgeSnum = 0n;
    this.domEdgeBCount = 0;
  }

  private setBitRate(bitrate: number): void {
    if (!this.samplerate || !(bitrate > 0)) throw new RangeError('Invalid CAN bitrate or sample rate.');
    this.bitWidth = this.samplerate / bitrate;
    this.samplePoint = (this.bitWidth * Number(this.options.sample_point)) / 100;
  }

  private setNominalBitrate(): void {
    this.setBitRate(Number(this.options.nominal_bitrate));
  }

  private setFastBitrate(): void {
    this.setBitRate(Number(this.options.fast_bitrate));
  }

  private dataLength(): number {
    return this.rtrType === 'remote' ? 0 : dlcToLength(this.dlc ?? 0);
  }

  private putG(ss: bigint, es: bigint, data: AnnotationData): void {
    const left = BigInt(Math.trunc(this.samplePoint));
    const right = BigInt(Math.trunc(this.bitWidth - this.samplePoint));
    this.put(ss - left, es + right, this.outAnn, data);
  }

  private putX(data: AnnotationData): void {
    this.putG(this.samplenum, this.samplenum, data);
  }

  private put12(data: AnnotationData): void {
    if (this.ssBit12 !== null) this.putG(this.ssBit12, this.ssBit12, data);
  }

  private put32(data: AnnotationData): void {
    if (this.ssBit32 !== null) this.putG(this.ssBit32, this.ssBit32, data);
  }

  private putB(data: AnnotationData): void {
    if (this.ssBlock !== null) this.putG(this.ssBlock, this.samplenum, data);
  }

  private domEdgeSeen(): void {
    this.domEdgeSnum = this.samplenum;
    this.domEdgeBCount = this.curbit;
  }

  private samplePointFor(bitnum: number): bigint {
    const delta = Math.trunc(this.bitWidth * (bitnum - this.domEdgeBCount) + this.samplePoint);
    return this.domEdgeSnum + BigInt(delta);
  }

  private isStuffBit(): boolean {
    if (this.bits.length > this.lastDatabit + 17) return false;
    const last = this.rawBits.slice(-6);
    if (
      last.length !== 6 ||
      !(
        last.every((bit, index) => bit === (index === 5 ? 1 : 0)) ||
        last.every((bit, index) => bit === (index === 5 ? 0 : 1))
      )
    )
      return false;
    this.bits.pop();
    return true;
  }

  private decodeFrameEnd(canRx: number, bitnum: number): boolean {
    if (bitnum === this.lastDatabit + 1) {
      this.ssBlock = this.samplenum;
      this.crcLen = this.fd ? (dlcToLength(this.dlc ?? 0) < 16 ? 27 : 32) : 15;
    } else if (bitnum === this.lastDatabit + this.crcLen) {
      let crcType = 'CRC-15';
      if (this.fd) crcType = dlcToLength(this.dlc ?? 0) < 16 ? 'CRC-17' : 'CRC-21';
      const start = this.lastDatabit + 1;
      const crc = bitpack_msb(this.bits.slice(start, start + this.crcLen + 1));
      const hex = crc.toString(16).padStart(4, '0');
      this.putB([11, [`${crcType} sequence: 0x${hex}`, `${crcType}: 0x${hex}`, crcType]]);
    } else if (bitnum === this.lastDatabit + this.crcLen + 1) {
      this.putX([12, [`CRC delimiter: ${canRx}`, `CRC d: ${canRx}`, 'CRC d']]);
      if (canRx !== 1) this.putX([16, ['CRC delimiter must be a recessive bit']]);
      if (this.fd) this.setNominalBitrate();
    } else if (bitnum === this.lastDatabit + this.crcLen + 2) {
      const ack = canRx === 0 ? 'ACK' : 'NACK';
      this.putX([13, [`ACK slot: ${ack}`, `ACK s: ${ack}`, 'ACK s']]);
    } else if (bitnum === this.lastDatabit + this.crcLen + 3) {
      this.putX([14, [`ACK delimiter: ${canRx}`, `ACK d: ${canRx}`, 'ACK d']]);
      if (canRx !== 1) this.putX([16, ['ACK delimiter must be a recessive bit']]);
    } else if (bitnum === this.lastDatabit + this.crcLen + 4) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === this.lastDatabit + this.crcLen + 10) {
      this.putB([2, ['End of frame', 'EOF', 'E']]);
      if (this.rawBits.slice(-7).some((bit) => bit !== 1))
        this.putB([16, ['End of frame (EOF) must be 7 recessive bits']]);
      this.esPacket = this.samplenum;
      if (this.ssPacket !== null && this.frameType !== null && this.dlc !== null)
        this.put(this.ssPacket, this.esPacket, this.outProtocol, [
          this.frameType,
          this.fullId,
          this.rtrType,
          this.dlc,
          [...this.frameBytes],
        ] satisfies CanProtocolPacket);
      this.resetState();
      return true;
    }
    return false;
  }

  private decodeStandardFrame(canRx: number, bitnum: number): boolean {
    if (bitnum === 14) {
      this.fd = canRx === 1;
      if (this.fd) {
        this.putX([7, [`Flexible data format: ${canRx}`, `FDF: ${canRx}`, 'FDF']]);
        this.put12([8, ['Substitute remote request', 'SRR']]);
        this.dlcStart = 18;
      } else {
        this.putX([7, [`Reserved bit 0: ${canRx}`, `RB0: ${canRx}`, 'RB0']]);
        const rtr = this.bits[12] === 1 ? 'remote' : 'data';
        this.put12([8, [`Remote transmission request: ${rtr} frame`, `RTR: ${rtr} frame`, 'RTR']]);
        this.rtrType = rtr;
        this.dlcStart = 15;
      }
    }
    if (bitnum === 15 && this.fd) this.putX([7, [`Reserved: ${canRx}`, `R0: ${canRx}`, 'R0']]);
    if (bitnum === 16 && this.fd) this.putX([7, [`Bit rate switch: ${canRx}`, `BRS: ${canRx}`, 'BRS']]);
    if (bitnum === 17 && this.fd) this.putX([7, [`Error state indicator: ${canRx}`, `ESI: ${canRx}`, 'ESI']]);
    else if (bitnum === this.dlcStart) this.ssBlock = this.samplenum;
    else if (bitnum === this.dlcStart + 3) {
      this.dlc = bitpack_msb(this.bits.slice(this.dlcStart, this.dlcStart + 4));
      this.putB([10, [`Data length code: ${this.dlc}`, `DLC: ${this.dlc}`, 'DLC']]);
      this.lastDatabit = this.dlcStart + 3 + this.dataLength() * 8;
      if (this.dlc > 8 && !this.fd) this.putB([16, ['Data length code (DLC) > 8 is not allowed']]);
    } else if (bitnum >= this.dlcStart + 4 && bitnum < this.lastDatabit) {
      this.ssDatabyteBits.push(this.samplenum);
    } else if (bitnum === this.lastDatabit) {
      this.ssDatabyteBits.push(this.samplenum);
      for (let index = 0; index < this.dataLength(); index++) {
        const start = this.dlcStart + 4 + 8 * index;
        const value = bitpack_msb(this.bits.slice(start, start + 8));
        this.frameBytes.push(value);
        const ss = this.ssDatabyteBits[index * 8]!;
        const es = this.ssDatabyteBits[(index + 1) * 8 - 1]!;
        const hex = value.toString(16).padStart(2, '0');
        this.putG(ss, es, [0, [`Data byte ${index}: 0x${hex}`, `DB ${index}: 0x${hex}`, 'DB']]);
      }
      this.ssDatabyteBits = [];
    } else if (bitnum > this.lastDatabit) return this.decodeFrameEnd(canRx, bitnum);
    return false;
  }

  private decodeExtendedFrame(canRx: number, bitnum: number): boolean {
    if (bitnum === 14) {
      this.ssBlock = this.samplenum;
      this.fd = false;
      this.dlcStart = 35;
    } else if (bitnum === 31) {
      this.eid = bitpack_msb(this.bits.slice(14));
      const extended = `${this.eid} (0x${this.eid.toString(16)})`;
      this.putB([4, [`Extended Identifier: ${extended}`, `Extended ID: ${extended}`, 'Extended ID', 'EID']]);
      this.fullId = (this.ident << 18) | this.eid;
      const full = `${this.fullId} (0x${this.fullId.toString(16)})`;
      this.putB([5, [`Full Identifier: ${full}`, `Full ID: ${full}`, 'Full ID', 'FID']]);
      this.put12([9, [`Substitute remote request: ${this.bits[12]}`, `SRR: ${this.bits[12]}`, 'SRR']]);
    }
    if (bitnum === 32) {
      this.ssBit32 = this.samplenum;
      this.rtr = canRx;
      if (!this.fd) {
        const rtr = canRx === 1 ? 'remote' : 'data';
        this.putX([8, [`Remote transmission request: ${rtr} frame`, `RTR: ${rtr} frame`, 'RTR']]);
        this.rtrType = rtr;
      }
    } else if (bitnum === 33) {
      this.fd = canRx === 1;
      if (this.fd) {
        this.dlcStart = 37;
        this.putX([7, [`Flexible data format: ${canRx}`, `FDF: ${canRx}`, 'FDF']]);
        this.put32([7, [`Reserved bit 1: ${this.rtr}`, `RB1: ${this.rtr}`, 'RB1']]);
      } else {
        this.putX([7, [`Reserved bit 1: ${canRx}`, `RB1: ${canRx}`, 'RB1']]);
      }
    } else if (bitnum === 34) {
      this.putX([7, [`Reserved bit 0: ${canRx}`, `RB0: ${canRx}`, 'RB0']]);
    } else if (bitnum === 35 && this.fd) {
      this.putX([7, [`Bit rate switch: ${canRx}`, `BRS: ${canRx}`, 'BRS']]);
    } else if (bitnum === 36 && this.fd) {
      this.putX([7, [`Error state indicator: ${canRx}`, `ESI: ${canRx}`, 'ESI']]);
    } else if (bitnum === this.dlcStart) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === this.dlcStart + 3) {
      this.dlc = bitpack_msb(this.bits.slice(this.dlcStart, this.dlcStart + 4));
      this.putB([10, [`Data length code: ${this.dlc}`, `DLC: ${this.dlc}`, 'DLC']]);
      this.lastDatabit = this.dlcStart + 3 + this.dataLength() * 8;
    } else if (bitnum >= this.dlcStart + 4 && bitnum < this.lastDatabit) {
      this.ssDatabyteBits.push(this.samplenum);
    } else if (bitnum === this.lastDatabit) {
      this.ssDatabyteBits.push(this.samplenum);
      for (let index = 0; index < this.dataLength(); index++) {
        const start = this.dlcStart + 4 + 8 * index;
        const value = bitpack_msb(this.bits.slice(start, start + 8));
        this.frameBytes.push(value);
        const ss = this.ssDatabyteBits[index * 8]!;
        const es = this.ssDatabyteBits[(index + 1) * 8 - 1]!;
        const hex = value.toString(16).padStart(2, '0');
        this.putG(ss, es, [0, [`Data byte ${index}: 0x${hex}`, `DB ${index}: 0x${hex}`, 'DB']]);
      }
      this.ssDatabyteBits = [];
    } else if (bitnum > this.lastDatabit) return this.decodeFrameEnd(canRx, bitnum);
    return false;
  }

  private handleBit(canRx: number): void {
    this.rawBits.push(canRx);
    this.bits.push(canRx);
    const bitnum = this.bits.length - 1;

    if (
      this.fd &&
      canRx === 1 &&
      ((bitnum === 16 && this.frameType === 'standard') || (bitnum === 35 && this.frameType === 'extended'))
    ) {
      this.domEdgeSeen();
      this.setFastBitrate();
    }

    if (this.isStuffBit()) {
      this.putX([15, [String(canRx)]]);
      this.curbit++;
      return;
    }
    this.putX([17, [String(canRx)]]);

    if (bitnum === 0) {
      this.ssPacket = this.samplenum;
      this.putX([1, ['Start of frame', 'SOF', 'S']]);
      if (canRx !== 0) this.putX([16, ['Start of frame (SOF) must be a dominant bit']]);
    } else if (bitnum === 1) {
      this.ssBlock = this.samplenum;
    } else if (bitnum === 11) {
      this.ident = bitpack_msb(this.bits.slice(1));
      this.fullId = this.ident;
      const text = `${this.ident} (0x${this.ident.toString(16)})`;
      this.putB([3, [`Identifier: ${text}`, `ID: ${text}`, 'ID']]);
      if ((this.ident & 0x7f0) === 0x7f0) this.putB([16, ['Identifier bits 10..4 must not be all recessive']]);
    } else if (bitnum === 12) {
      this.ssBit12 = this.samplenum;
    } else if (bitnum === 13) {
      const ide = (this.frameType = canRx === 0 ? 'standard' : 'extended');
      this.putX([6, [`Identifier extension bit: ${ide} frame`, `IDE: ${ide} frame`, 'IDE']]);
    } else if (bitnum >= 14) {
      const done =
        this.frameType === 'standard'
          ? this.decodeStandardFrame(canRx, bitnum)
          : this.decodeExtendedFrame(canRx, bitnum);
      if (done) return;
    }
    this.curbit++;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    while (true) {
      if (this.state === 'IDLE') {
        yield this.wait({ 0: 'l' });
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

export default CanDecoder;
