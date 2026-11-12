import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const T55_ANN = Object.freeze({
  BIT_VALUE: 0,
  START_GAP: 1,
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

const BITRATES = ['RF/8', 'RF/16', 'RF/32', 'RF/40', 'RF/50', 'RF/64', 'RF/100', 'RF/128'];
const MODULATION_1 = ['Direct', 'Manchester', 'Biphase', 'Reserved'];
const MODULATION_2 = ['Direct', 'PSK1', 'PSK2', 'PSK3', 'FSK1', 'FSK2', 'FSK1a', 'FSK2a'];
const PSK_CF = ['RF/2', 'RF/4', 'RF/8', 'Reserved'];

export class T55xxDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private outAnn = -1;
  private fieldClock = 0;
  private zeroMin = 0;
  private zeroMax = 0;
  private oneMin = 0;
  private oneMax = 0;
  private startGap = 0;
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
    this.zeroMax = Number(this.options.w_zero_max) * this.fieldClock;
    this.zeroMin = Number(this.options.w_zero_min) * this.fieldClock;
    this.oneMax = Number(this.options.w_one_max) * this.fieldClock;
    this.oneMin = Number(this.options.w_one_min) * this.fieldClock;
    this.startGap = Number(this.options.start_gap) * this.fieldClock;
    this.writeGap = Number(this.options.w_gap) * this.fieldClock;
    this.noGap = 64 * this.fieldClock;
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

  private put4Bits(index: number): void {
    const value =
      (this.getBit(index) << 3) |
      (this.getBit(index + 1) << 2) |
      (this.getBit(index + 2) << 1) |
      this.getBit(index + 3);
    this.put(this.bits[index]!.ss, this.bits[index + 3]!.es, this.outAnn, [
      T55_ANN.DECODE,
      [value.toString(16).toUpperCase()],
    ]);
  }

  private decodeConfig(index: number): void {
    const put = (start: number, end: number, texts: readonly string[]): void =>
      this.put(this.bits[start]!.ss, this.bits[end]!.es, this.outAnn, [T55_ANN.DECODE, texts]);
    const saferKey = this.getBits(index, 4);
    put(index, index + 3, [`Safer Key: ${saferKey.toString(16).toUpperCase()}`, saferKey.toString(16).toUpperCase()]);
    const bitrate = (this.getBit(index + 11) << 2) | (this.getBit(index + 12) << 1) | this.getBit(index + 13);
    put(index + 11, index + 13, [`Data Bit Rate: ${BITRATES[bitrate]}`, BITRATES[bitrate]!]);
    const modulation1 = (this.getBit(index + 15) << 1) | this.getBit(index + 16);
    const modulation2 = (this.getBit(index + 17) << 2) | (this.getBit(index + 18) << 1) | this.getBit(index + 19);
    const modulation = modulation1 === 0 ? MODULATION_2[modulation2]! : MODULATION_1[modulation1]!;
    put(index + 15, index + 19, [`Modulation: ${modulation}`, modulation]);
    const pskCf = (this.getBit(index + 20) << 1) | this.getBit(index + 21);
    put(index + 20, index + 21, [`PSK-CF: ${PSK_CF[pskCf]}`, PSK_CF[pskCf]!]);
    put(index + 22, index + 22, [`AOR: ${this.getBit(index + 22)}`, String(this.getBit(index + 22))]);
    const maxBlock = (this.getBit(index + 24) << 2) | (this.getBit(index + 25) << 1) | this.getBit(index + 26);
    put(index + 24, index + 26, [`Max-Block: ${maxBlock}`, String(maxBlock)]);
    put(index + 27, index + 27, [`PWD: ${this.getBit(index + 27)}`, String(this.getBit(index + 27))]);
    put(index + 28, index + 28, [
      `ST-sequence terminator: ${this.getBit(index + 28)}`,
      String(this.getBit(index + 28)),
    ]);
    put(index + 31, index + 31, [`POR delay: ${this.getBit(index + 31)}`, String(this.getBit(index + 31))]);
  }

  private em4100Decode1(index: number): void {
    const put = (start: number, end: number, texts: readonly string[]): void =>
      this.put(this.bits[start]!.ss, this.bits[end]!.es, this.outAnn, [T55_ANN.DECODE, texts]);
    put(index, index + 8, ['EM4100 header', 'EM header', 'Header', 'H']);
    this.put4Bits(index + 9);
    this.put4Bits(index + 14);
    this.put4Bits(index + 19);
    this.put4Bits(index + 24);
    this.emPartial = (this.getBit(index + 29) << 3) | (this.getBit(index + 30) << 2) | (this.getBit(index + 31) << 1);
    put(index + 29, index + 31, ['Partial nibble']);
  }

  private em4100Decode2(index: number): void {
    const put = (start: number, end: number, texts: readonly string[]): void =>
      this.put(this.bits[start]!.ss, this.bits[end]!.es, this.outAnn, [T55_ANN.DECODE, texts]);
    if (this.emPartial !== 0) {
      const bits = this.emPartial + this.getBit(index);
      put(index, index, [bits.toString(16).toUpperCase()]);
      this.emPartial = 0;
    } else {
      put(index, index, ['Partial nibble']);
    }
    this.put4Bits(index + 2);
    this.put4Bits(index + 7);
    this.put4Bits(index + 12);
    this.put4Bits(index + 17);
    this.put4Bits(index + 22);
    put(index + 27, index + 31, ['EM4100 trailer']);
  }

  private putFields(): void {
    if (this.bitCount === 70) {
      const opcode = `${this.getBit(0)}${this.getBit(1)}`;
      this.put(this.bits[0]!.ss, this.bits[1]!.es, this.outAnn, [T55_ANN.OPCODE, [`Opcode: ${opcode}`, opcode]]);
      const password = this.get32Bits(2);
      this.put(this.bits[2]!.ss, this.bits[33]!.es, this.outAnn, [
        T55_ANN.PASSWORD,
        [`Password: ${password.toString(16).toUpperCase()}`, password.toString(16).toUpperCase()],
      ]);
      this.put(this.bits[34]!.ss, this.bits[34]!.es, this.outAnn, [
        T55_ANN.LOCK,
        [`Lock: ${this.getBit(34).toString(16).toUpperCase()}`, this.getBit(34).toString(16).toUpperCase()],
      ]);
      const data = this.get32Bits(35);
      this.put(this.bits[35]!.ss, this.bits[66]!.es, this.outAnn, [
        T55_ANN.DATA,
        [`Data: ${data.toString(16).toUpperCase()}`, data.toString(16).toUpperCase()],
      ]);
      const address = (this.getBit(67) << 2) | (this.getBit(68) << 1) | this.getBit(69);
      this.put(this.bits[67]!.ss, this.bits[69]!.es, this.outAnn, [
        T55_ANN.ADDRESS,
        [`Addr: ${address.toString(16).toUpperCase()}`, address.toString(16).toUpperCase()],
      ]);
      if (address === 0) this.decodeConfig(35);
      if (address === 7)
        this.put(this.bits[35]!.ss, this.bits[66]!.es, this.outAnn, [
          T55_ANN.DECODE,
          [`Password: ${data.toString(16).toUpperCase()}`, data.toString(16).toUpperCase()],
        ]);
      if (address === 1 && this.options.em4100_decode === 'on') this.em4100Decode1(35);
      if (address === 2 && this.options.em4100_decode === 'on') this.em4100Decode2(35);
    } else if (this.bitCount === 38) {
      const opcode = `${this.getBit(0)}${this.getBit(1)}`;
      this.put(this.bits[0]!.ss, this.bits[1]!.es, this.outAnn, [T55_ANN.OPCODE, [`Opcode: ${opcode}`, opcode]]);
      this.put(this.bits[2]!.ss, this.bits[2]!.es, this.outAnn, [
        T55_ANN.LOCK,
        [`Lock: ${this.getBit(2).toString(16).toUpperCase()}`, this.getBit(2).toString(16).toUpperCase()],
      ]);
      const data = this.get32Bits(3);
      this.put(this.bits[3]!.ss, this.bits[34]!.es, this.outAnn, [
        T55_ANN.DATA,
        [`Data: ${data.toString(16).toUpperCase()}`, data.toString(16).toUpperCase()],
      ]);
      const address = (this.getBit(35) << 2) | (this.getBit(36) << 1) | this.getBit(37);
      this.put(this.bits[35]!.ss, this.bits[37]!.es, this.outAnn, [
        T55_ANN.ADDRESS,
        [`Addr: ${address.toString(16).toUpperCase()}`, address.toString(16).toUpperCase()],
      ]);
      if (address === 0) this.decodeConfig(3);
      if (address === 7)
        this.put(this.bits[3]!.ss, this.bits[34]!.es, this.outAnn, [
          T55_ANN.DECODE,
          [`Password: ${data.toString(16).toUpperCase()}`, data.toString(16).toUpperCase()],
        ]);
      if (address === 1 && this.options.em4100_decode === 'on') this.em4100Decode1(3);
      if (address === 2 && this.options.em4100_decode === 'on') this.em4100Decode2(3);
    } else if (this.bitCount === 2) {
      const opcode = `${this.getBit(0)}${this.getBit(1)}`;
      this.put(this.bits[0]!.ss, this.bits[1]!.es, this.outAnn, [T55_ANN.OPCODE, [`Opcode: ${opcode}`, opcode]]);
    }
    this.bitCount = 0;
  }

  private addBit(value: number, ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [T55_ANN.BIT_VALUE, [String(value)]]);
    this.put(ss, es, this.outAnn, [T55_ANN.BIT, ['Bit']]);
    if (this.bitCount < 70) {
      this.bits[this.bitCount] = { value, ss, es };
      this.bitCount++;
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    if (!(this.fieldClock > 0)) throw new Error('Invalid T55xx field clock.');
    yield this.wait();
    let edge = this.samplenum > 0n ? this.samplenum - 1n : 0n;
    while (true) {
      yield this.wait({ data: 'e' });
      const now = this.samplenum;
      const length = Number(now - edge);
      if (!this.armed) {
        if (length > this.startGap) {
          this.put(edge, now, this.outAnn, [T55_ANN.START_GAP, ['Start gap']]);
          this.armed = true;
          this.bitCount = 0;
        }
      } else if (length > this.noGap) {
        if (this.bitCount) this.putFields();
        this.put(edge, now, this.outAnn, [T55_ANN.WRITE_EXIT, ['Write mode exit']]);
        this.armed = false;
      } else {
        if (length > this.writeGap) this.put(edge, now, this.outAnn, [T55_ANN.WRITE_GAP, ['Write gap']]);
        if (length > this.zeroMin && length < this.zeroMax) {
          this.addBit(0, edge, now);
        } else if (length > this.oneMin && length < this.oneMax) {
          this.addBit(1, edge, now);
        }
      }
      edge = now;
    }
  }

  onEof(): void {
    if (this.armed && this.bitCount) this.putFields();
  }
}

export default T55xxDecoder;
