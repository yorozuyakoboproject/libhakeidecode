import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const EM4305_ANN = Object.freeze({
  BIT_VALUE: 0,
  FIRST_FIELD_STOP: 1,
  WRITE_GAP: 2,
  WRITE_EXIT: 3,
  BIT: 4,
  OPCODE: 5,
  LOCK: 6,
  DATA: 7,
  PASSWORD: 8,
  ADDRESS: 9,
  DECODE: 10,
});

interface BitPosition {
  value: number;
  ss: bigint;
  es: bigint;
}

const BITRATES = ['RF/8', 'RF/16', 'Unused', 'RF/32', 'RF/40', 'Unused', 'Unused', 'RF/64'];
const ENCODERS = ['not used', 'Manchester', 'Bi-phase', 'not used'];
const DELAYS = ['No delay', 'Delayed on - BP/8', 'Delayed on - BP/4', 'No delay'];
const COMMANDS = ['Invalid', 'Login', 'Write word', 'Invalid', 'Read word', 'Disable', 'Protect', 'Invalid'];

export class Em4305Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private outAnn = -1;
  private fieldClock = 0;
  private zeroMin = 0;
  private zeroMax = 0;
  private oneMax = 0;
  private firstStop = 0;
  private writeGap = 0;
  private noGap = 0;
  private armed = false;
  private bitCount = 0;
  private bits: BitPosition[] = Array.from({ length: 70 }, () => ({ value: 0, ss: 0n, es: 0n }));
  private emPartial = 0;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.fieldClock = 0;
    this.armed = false;
    this.bitCount = 0;
    this.bits = Array.from({ length: 70 }, () => ({ value: 0, ss: 0n, es: 0n }));
    this.emPartial = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key !== SRD_CONF_SAMPLERATE) return;
    this.samplerate = value;
    this.fieldClock = value / Number(this.options.coilfreq);
    this.zeroMax = Number(this.options.w_zero_off_max) * this.fieldClock;
    this.zeroMin = Number(this.options.w_zero_on_min) * this.fieldClock;
    this.oneMax = Number(this.options.w_one_max) * this.fieldClock;
    this.firstStop = Number(this.options.first_field_stop) * this.fieldClock;
    this.writeGap = Number(this.options.w_gap) * this.fieldClock;
    this.noGap = 300 * this.fieldClock;
  }

  private getBit(index: number): number {
    return this.bits[index]?.value ?? 0;
  }

  private getBits(index: number, count: number): number {
    let value = 0;
    for (let offset = 0; offset < count; offset++) value = (value << 1) | this.getBit(index + offset);
    return value;
  }

  private get32Bits(index: number): number {
    return this.getBits(index, 32) >>> 0;
  }

  private get3Bits(index: number): number {
    return (this.getBit(index) << 2) | (this.getBit(index + 1) << 1) | this.getBit(index + 2);
  }

  private get4Bits(index: number): number {
    return (
      this.getBit(index) | (this.getBit(index + 1) << 1) | (this.getBit(index + 2) << 2) | (this.getBit(index + 3) << 3)
    );
  }

  private putAt(start: number, end: number, classIndex: number, texts: readonly string[]): void {
    this.put(this.bits[start]!.ss, this.bits[end]!.es, this.outAnn, [classIndex, texts]);
  }

  private put4Bits(index: number): void {
    const value =
      (this.getBit(index) << 3) |
      (this.getBit(index + 1) << 2) |
      (this.getBit(index + 2) << 1) |
      this.getBit(index + 3);
    this.putAt(index, index + 3, EM4305_ANN.DECODE, [value.toString(16).toUpperCase()]);
  }

  private decodeConfig(index: number): void {
    const bitrate = this.get3Bits(index + 2);
    this.putAt(index, index + 5, EM4305_ANN.DECODE, [`Data rate: ${BITRATES[bitrate]}`, BITRATES[bitrate]!]);
    const encoding = (this.getBit(index + 6) << 0) | (this.getBit(index + 7) << 1);
    this.putAt(index + 6, index + 10, EM4305_ANN.DECODE, [`Encoder: ${ENCODERS[encoding]}`, ENCODERS[encoding]!]);
    this.putAt(index + 11, index + 12, EM4305_ANN.DECODE, ['Zero bits', 'ZB']);
    const delay = (this.getBit(index + 13) << 0) | (this.getBit(index + 14) << 1);
    this.putAt(index + 13, index + 14, EM4305_ANN.DECODE, [`Delayed on: ${DELAYS[delay]}`, DELAYS[delay]!]);
    const lwr =
      (this.getBit(index + 15) << 3) |
      (this.getBit(index + 16) << 2) |
      (this.getBit(index + 18) << 1) |
      this.getBit(index + 19);
    this.putAt(index + 15, index + 19, EM4305_ANN.DECODE, [
      `Last default read word: ${lwr}`,
      `LWR: ${lwr}`,
      String(lwr),
    ]);
    this.putAt(index + 20, index + 20, EM4305_ANN.DECODE, [
      `Read login: ${this.getBit(index + 20)}`,
      String(this.getBit(index + 20)),
    ]);
    this.putAt(index + 21, index + 21, EM4305_ANN.DECODE, ['Zero bits', 'ZB']);
    this.putAt(index + 22, index + 22, EM4305_ANN.DECODE, [
      `Write login: ${this.getBit(index + 22)}`,
      String(this.getBit(index + 22)),
    ]);
    this.putAt(index + 23, index + 24, EM4305_ANN.DECODE, ['Zero bits', 'ZB']);
    this.putAt(index + 25, index + 25, EM4305_ANN.DECODE, [
      `Disable: ${this.getBit(index + 25)}`,
      String(this.getBit(index + 25)),
    ]);
    this.putAt(index + 27, index + 27, EM4305_ANN.DECODE, [
      `Reader talk first: ${this.getBit(index + 27)}`,
      `RTF: ${this.getBit(index + 27)}`,
    ]);
    this.putAt(index + 28, index + 28, EM4305_ANN.DECODE, ['Zero bits', 'ZB']);
    this.putAt(index + 29, index + 29, EM4305_ANN.DECODE, [
      `Pigeon mode: ${this.getBit(index + 29)}`,
      String(this.getBit(index + 29)),
    ]);
    this.putAt(index + 30, index + 34, EM4305_ANN.DECODE, ['Reserved', 'Res', 'R']);
  }

  private em4100Decode1(index: number): void {
    this.putAt(index, index + 9, EM4305_ANN.DECODE, ['EM4100 header', 'EM header', 'Header', 'H']);
    this.put4Bits(index + 10);
    const bits =
      (this.getBit(index + 15) << 3) |
      (this.getBit(index + 16) << 2) |
      (this.getBit(index + 18) << 1) |
      this.getBit(index + 19);
    this.putAt(index + 15, index + 19, EM4305_ANN.DECODE, [bits.toString(16).toUpperCase()]);
    this.put4Bits(index + 21);
    this.put4Bits(index + 27);
    this.emPartial = (this.getBit(index + 32) << 3) | (this.getBit(index + 33) << 2) | (this.getBit(index + 34) << 1);
    this.putAt(index + 32, index + 34, EM4305_ANN.DECODE, ['Partial nibble']);
  }

  private em4100Decode2(index: number): void {
    if (this.emPartial !== 0) {
      const bits = this.emPartial + this.getBit(index);
      this.putAt(index, index, EM4305_ANN.DECODE, [bits.toString(16).toUpperCase()]);
      this.emPartial = 0;
    } else {
      this.putAt(index, index, EM4305_ANN.DECODE, ['Partial nibble']);
    }
    this.put4Bits(index + 2);
    const bits =
      (this.getBit(index + 7) << 3) |
      (this.getBit(index + 9) << 2) |
      (this.getBit(index + 10) << 1) |
      this.getBit(index + 11);
    this.putAt(index + 7, index + 11, EM4305_ANN.DECODE, [bits.toString(16).toUpperCase()]);
    this.put4Bits(index + 13);
    this.put4Bits(index + 19);
    const tail =
      (this.getBit(index + 24) << 3) |
      (this.getBit(index + 25) << 2) |
      (this.getBit(index + 27) << 1) |
      this.getBit(index + 28);
    this.putAt(index + 24, index + 28, EM4305_ANN.DECODE, [tail.toString(16).toUpperCase()]);
    this.putAt(index + 30, index + 34, EM4305_ANN.DECODE, ['EM4100 trailer']);
  }

  private printRowParity(index: number, length: number): void {
    let parity = 0;
    for (let offset = 0; offset < length; offset++) parity ^= this.getBit(index + offset);
    const ok = parity === this.getBit(index + length);
    this.putAt(index + length, index + length, EM4305_ANN.OPCODE, [
      ok ? 'Row parity OK' : 'Row parity failed',
      ok ? 'Parity OK' : 'Parity failed',
      ok ? 'OK' : 'Fail',
    ]);
  }

  private printColumnParity(index: number): void {
    const value =
      this.getBits(index, 8) ^ this.getBits(index + 9, 8) ^ this.getBits(index + 18, 8) ^ this.getBits(index + 27, 8);
    const ok = value === this.getBits(index + 36, 8);
    this.putAt(index + 36, index + 43, EM4305_ANN.OPCODE, [
      ok ? 'Column parity OK' : 'Column parity failed',
      ok ? 'Parity OK' : 'Parity failed',
      ok ? 'OK' : 'Fail',
    ]);
  }

  private printData(index: number): void {
    const value = this.getBits(index, 8);
    this.putAt(index, index + 7, EM4305_ANN.ADDRESS, [
      `Data: ${value.toString(16).toUpperCase()}`,
      value.toString(16).toUpperCase(),
    ]);
  }

  private putFields(): void {
    if (this.bitCount === 50) {
      this.putAt(0, 0, EM4305_ANN.BIT, ['Logic zero']);
      this.putAt(1, 4, EM4305_ANN.BIT, ['Command', 'Cmd', 'C']);
      this.putAt(5, 49, EM4305_ANN.BIT, ['Password', 'Passwd', 'Pass', 'P']);
      const command = this.get3Bits(1);
      this.putAt(1, 3, EM4305_ANN.OPCODE, [COMMANDS[command]!]);
      this.printRowParity(1, 3);
      for (const index of [5, 14, 23, 32]) {
        this.printData(index);
        this.printRowParity(index, 8);
      }
      this.printColumnParity(5);
      this.putAt(49, 49, EM4305_ANN.OPCODE, [this.getBit(49) === 0 ? 'Stop bit' : 'Stop bit error', 'Stop', 'SB']);
      if (command === 1) {
        const password = this.get32Bits(5);
        this.putAt(5, 36, EM4305_ANN.DECODE, [`Login password: ${password.toString(16).toUpperCase()}`]);
      }
    } else if (this.bitCount === 57) {
      this.putAt(0, 0, EM4305_ANN.BIT, ['Logic zero', 'LZ']);
      this.putAt(1, 4, EM4305_ANN.BIT, ['Command', 'Cmd', 'C']);
      this.putAt(5, 11, EM4305_ANN.BIT, ['Address', 'Addr', 'A']);
      this.putAt(12, 56, EM4305_ANN.BIT, ['Data', 'Da', 'D']);
      const command = this.get3Bits(1);
      this.putAt(1, 3, EM4305_ANN.OPCODE, [COMMANDS[command]!]);
      this.printRowParity(1, 3);
      const address = this.get4Bits(5);
      this.putAt(5, 8, EM4305_ANN.ADDRESS, [`Addr: ${address}`, String(address)]);
      this.putAt(9, 10, EM4305_ANN.OPCODE, ['Zero bits', 'ZB']);
      this.printRowParity(5, 6);
      for (const index of [12, 21, 30, 39]) {
        this.printData(index);
        this.printRowParity(index, 8);
      }
      this.printColumnParity(12);
      this.putAt(56, 56, EM4305_ANN.OPCODE, [this.getBit(56) === 0 ? 'Stop bit' : 'Stop bit error', 'Stop', 'SB']);
      if (address === 4) this.decodeConfig(12);
      if (address === 2) {
        const password = this.get32Bits(12);
        this.putAt(12, 43, EM4305_ANN.DECODE, [`Write password: ${password.toString(16).toUpperCase()}`]);
      }
      if (address === 5 && this.options.em4100_decode === 'on') this.em4100Decode1(12);
      if (address === 6 && this.options.em4100_decode === 'on') this.em4100Decode2(12);
    }
    this.bitCount = 0;
  }

  private addBit(value: number, ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [EM4305_ANN.BIT_VALUE, [String(value)]]);
    if (this.bitCount < 70) {
      this.bits[this.bitCount] = { value, ss, es };
      this.bitCount++;
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    if (!(this.fieldClock > 0)) throw new Error('Invalid EM4305 field clock.');
    yield this.wait();
    let edge = this.samplenum > 0n ? this.samplenum - 1n : 0n;
    while (true) {
      yield this.wait({ data: 'e' });
      const now = this.samplenum;
      const length = Number(now - edge);
      if (!this.armed) {
        if (length > this.firstStop) {
          this.put(edge, now, this.outAnn, [EM4305_ANN.FIRST_FIELD_STOP, ['First field stop', 'Field stop', 'FFS']]);
          this.armed = true;
          this.bitCount = 0;
        }
      } else if (length > this.noGap) {
        if (this.bitCount) this.putFields();
        this.put(edge, now, this.outAnn, [EM4305_ANN.WRITE_EXIT, ['Write mode exit']]);
        this.armed = false;
      } else {
        if (length > this.writeGap) this.put(edge, now, this.outAnn, [EM4305_ANN.WRITE_GAP, ['Write gap']]);
        if (length > this.zeroMin && length < this.zeroMax) {
          this.addBit(0, edge, now);
        } else if (length > this.oneMax && length < this.noGap) {
          const count = Math.floor(length / this.oneMax);
          let cursor = edge;
          for (let index = 0; index < count; index++) {
            const end = index === count - 1 ? now : cursor + BigInt(Math.trunc(this.oneMax));
            this.addBit(1, cursor, end);
            cursor = end;
          }
          const remainder = Number(now - cursor);
          if (remainder > this.zeroMin && remainder < this.zeroMax) this.addBit(0, cursor, now);
        }
      }
      edge = now;
    }
  }

  onEof(): void {
    if (this.armed && this.bitCount) this.putFields();
  }
}

export default Em4305Decoder;
