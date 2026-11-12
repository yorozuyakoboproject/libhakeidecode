import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export type NunchukOptions = Record<string, OptionValue>;

type State = 'idle' | 'get-slave-addr' | 'read-regs' | 'write-regs';
type BitInterval = readonly [ss: bigint, es: bigint];

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

export class NunchukDecoder extends Decoder<NunchukOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: State = 'idle';
  private sx = -1;
  private sy = -1;
  private ax = -1;
  private ay = -1;
  private az = -1;
  private bz = -1;
  private bc = -1;
  private reg = 0;
  private packetStart = 0n;
  private packetEnd = 0n;
  private blockStart = 0n;
  private blockEnd = 0n;
  private initSeq: number[] = [];
  private bits: BitInterval[] = [];

  override reset(): void {
    this.state = 'idle';
    this.sx = this.sy = this.ax = this.ay = this.az = this.bz = this.bc = -1;
    this.reg = 0;
    this.packetStart = this.packetEnd = this.blockStart = this.blockEnd = 0n;
    this.initSeq = [];
    this.bits = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putPacket(classIndex: number, texts: readonly string[]): void {
    this.put(this.packetStart, this.packetEnd, this.outAnn, [classIndex, texts]);
  }

  private putBlock(classIndex: number, texts: readonly string[]): void {
    this.put(this.blockStart, this.blockEnd, this.outAnn, [classIndex, texts]);
  }

  private putBits(first: number, last: number, classIndex: number, texts: readonly string[]): void {
    const start = this.bits[first]?.[0] ?? this.packetStart;
    const end = this.bits[last]?.[1] ?? this.packetEnd;
    this.put(start, end, this.outAnn, [classIndex, texts]);
  }

  private splitBits(ss: bigint, es: bigint): void {
    const span = es > ss ? es - ss : 0n;
    this.bits = [];
    for (let index = 0; index < 8; index++)
      this.bits.push([ss + (span * BigInt(7 - index)) / 8n, ss + (span * BigInt(8 - index)) / 8n]);
  }

  private handleRegister(register: number, value: number): void {
    if (register === 0x00) {
      this.blockStart = this.packetStart;
      this.sx = value;
      this.putPacket(0, [`Analog stick X position: 0x${hex(value, 2)}`, `SX: 0x${hex(value, 2)}`]);
    } else if (register === 0x01) {
      this.sy = value;
      this.putPacket(1, [`Analog stick Y position: 0x${hex(value, 2)}`, `SY: 0x${hex(value, 2)}`]);
    } else if (register === 0x02) {
      this.ax = value << 2;
      this.putPacket(2, [`Accelerometer X value bits[9:2]: 0x${hex(this.ax, 3)}`, `AX[9:2]: 0x${hex(this.ax, 3)}`]);
    } else if (register === 0x03) {
      this.ay = value << 2;
      this.putPacket(3, [`Accelerometer Y value bits[9:2]: 0x${hex(this.ay, 3)}`, `AY[9:2]: 0x${hex(this.ay, 3)}`]);
    } else if (register === 0x04) {
      this.az = value << 2;
      this.putPacket(4, [`Accelerometer Z value bits[9:2]: 0x${hex(this.az, 3)}`, `AZ[9:2]: 0x${hex(this.az, 3)}`]);
    } else if (register === 0x05) {
      this.blockEnd = this.packetEnd;
      this.bz = value & 1;
      this.bc = (value >> 1) & 1;
      const axRest = (value >> 2) & 3;
      const ayRest = (value >> 4) & 3;
      const azRest = (value >> 6) & 3;
      this.ax |= axRest;
      this.ay |= ayRest;
      this.az |= azRest;
      this.putBits(0, 0, 6, [`Z: ${this.bz === 0 ? '' : 'not '}pressed`, `BZ: ${this.bz}`]);
      this.putBits(1, 1, 7, [`C: ${this.bc === 0 ? '' : 'not '}pressed`, `BC: ${this.bc}`]);
      this.putBits(3, 2, 8, [
        `Accelerometer X value bits[1:0]: 0x${axRest.toString(16).toUpperCase()}`,
        `AX[1:0]: 0x${axRest.toString(16).toUpperCase()}`,
      ]);
      this.putBits(5, 4, 9, [
        `Accelerometer Y value bits[1:0]: 0x${ayRest.toString(16).toUpperCase()}`,
        `AY[1:0]: 0x${ayRest.toString(16).toUpperCase()}`,
      ]);
      this.putBits(7, 6, 10, [
        `Accelerometer Z value bits[1:0]: 0x${azRest.toString(16).toUpperCase()}`,
        `AZ[1:0]: 0x${azRest.toString(16).toUpperCase()}`,
      ]);
      this.reg = 0;
    }
  }

  private outputSummary(): void {
    if ([this.sx, this.sy, this.ax, this.ay, this.az, this.bz, this.bc].includes(-1)) return;
    const bz = this.bz === 0 ? 'pressed' : 'not pressed';
    const bc = this.bc === 0 ? 'pressed' : 'not pressed';
    this.putBlock(13, [
      `Analog stick: ${this.sx}/${this.sy}, accelerometer: ${this.ax}/${this.ay}/${this.az}, Z: ${bz}, C: ${bc}`,
    ]);
  }

  private handleRegWrite(value: number): void {
    this.putPacket(11, [`Nunchuk write: 0x${hex(value, 2)}`]);
    if (this.initSeq.length < 2) this.initSeq.push(value);
  }

  private outputInitSeq(): void {
    if (this.initSeq.length !== 2) {
      this.putBlock(14, [`Init sequence was ${this.initSeq.length} bytes long (2 expected)`]);
    } else if (this.initSeq[0] !== 0x40 || this.initSeq[1] !== 0x00) {
      this.putBlock(14, ['Unknown init sequence (expected: 0x40 0x00)']);
    } else {
      this.putBlock(12, ['Initialize Nunchuk', 'Init Nunchuk', 'Init', 'I']);
    }
  }

  private resetSensors(): void {
    this.sx = this.sy = this.ax = this.ay = this.az = this.bz = this.bc = -1;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    this.packetStart = ss;
    this.packetEnd = es;
    if (this.state === 'idle') {
      if (data[0] === 'START' && data[1] !== true) {
        this.state = 'get-slave-addr';
        this.blockStart = ss;
      }
      return;
    }
    if (this.state === 'get-slave-addr') {
      if (data[0] !== 'ADDRESS') return;
      if (data[1] === 'read') this.state = 'read-regs';
      else if (data[1] === 'write') this.state = 'write-regs';
      return;
    }
    if (this.state === 'read-regs') {
      if (data[0] === 'DATA' && data[1] === 'read' && typeof data[2] === 'number') {
        this.splitBits(ss, es);
        if (this.reg <= 5) this.handleRegister(this.reg, data[2]);
        this.reg++;
      } else if (data[0] === 'STOP') {
        this.blockEnd = es;
        this.outputSummary();
        this.resetSensors();
        this.state = 'idle';
      }
      return;
    }
    if (this.state === 'write-regs') {
      if (data[0] === 'DATA' && data[1] === 'write' && typeof data[2] === 'number') {
        this.handleRegWrite(data[2]);
      } else if (data[0] === 'STOP') {
        this.blockEnd = es;
        this.outputInitSeq();
        this.initSeq = [];
        this.state = 'idle';
      }
    }
  }
}

export default NunchukDecoder;
