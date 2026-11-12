import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const AC97_ANN = Object.freeze({
  BITS_OUT: 0,
  BITS_IN: 1,
  SLOT_RAW_OUT: 2,
  SLOT_RAW_IN: 3,
  WARNING: 4,
  ERROR: 5,
  SLOT_OUT_TAG: 6,
  SLOT_OUT_CMD_ADDR: 7,
  SLOT_OUT_CMD_DATA: 8,
  SLOT_OUT_03: 9,
  SLOT_OUT_04: 10,
  SLOT_OUT_05: 11,
  SLOT_OUT_06: 12,
  SLOT_OUT_07: 13,
  SLOT_OUT_08: 14,
  SLOT_OUT_09: 15,
  SLOT_OUT_10: 16,
  SLOT_OUT_11: 17,
  SLOT_OUT_IO_CTRL: 18,
  SLOT_IN_TAG: 19,
  SLOT_IN_STS_ADDR: 20,
  SLOT_IN_STS_DATA: 21,
  SLOT_IN_03: 22,
  SLOT_IN_04: 23,
  SLOT_IN_05: 24,
  SLOT_IN_06: 25,
  SLOT_IN_07: 26,
  SLOT_IN_08: 27,
  SLOT_IN_09: 28,
  SLOT_IN_10: 29,
  SLOT_IN_11: 30,
  SLOT_IN_IO_STS: 31,
});

export const AC97_BINARY = Object.freeze({
  FRAME_OUT: 0,
  FRAME_IN: 1,
  SLOT_RAW_OUT: 2,
  SLOT_RAW_IN: 3,
});

const SLOT_STARTS = [0, 16, 36, 56, 76, 96, 116, 136, 156, 176, 196, 216, 236, 256] as const;
const FRAME_BITS = 256;
const ERROR_TEXTS = ['reserved bit error', 'rsv error', 'rsv'] as const;

function nibbleText(value: number, bitCount: number): string {
  return value.toString(16).padStart(Math.ceil(bitCount / 4), '0');
}

function minWidthHex(value: number, width: number): string {
  return value.toString(16).padStart(width, ' ');
}

function bitField(data: number, size: number, offset: number, count: number): number {
  return (data >> (size - offset - count)) & ((1 << count) - 1);
}

function byteString(bits: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let offset = 0; offset < bits.length; offset += 8) {
    let value = 0;
    const end = Math.min(offset + 8, bits.length);
    for (let index = offset; index < end; index++) value = value * 2 + bits[index]!;
    bytes[offset / 8] = value;
  }
  return bytes;
}

export class Ac97Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private frameSamples: bigint[] | null = null;
  private frameBitsOut: number[] = [];
  private frameBitsIn: number[] = [];
  private slotDataOut: number[] = [];
  private slotDataIn: number[] = [];
  private slotsOut: boolean[] | null = null;
  private slotsIn: boolean[] | null = null;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.frameSamples = null;
    this.frameBitsOut = [];
    this.frameBitsIn = [];
    this.slotDataOut = [];
    this.slotDataIn = [];
    this.slotsOut = null;
    this.slotsIn = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outAnn = this.register(OUTPUT_ANN);
    if (!this.hasChannel('out') && !this.hasChannel('in'))
      throw new Error('Either SDATA_OUT or SDATA_IN (or both) are required.');
  }

  private putFrame(offset: number, count: number, classIndex: number, texts: readonly string[]): void {
    const frame = this.frameSamples!;
    this.put(frame[offset]!, frame[offset + count]!, this.outAnn, [classIndex, texts]);
  }

  private putFrameBinary(offset: number, count: number, classIndex: number, data: Uint8Array): void {
    if (!data.length) return;
    const frame = this.frameSamples!;
    this.put(frame[offset]!, frame[offset + count]!, this.outBinary, [classIndex, data]);
  }

  private flushFrameBits(): void {
    if (!this.frameSamples) return;
    if (this.frameBitsOut.length)
      this.putFrameBinary(0, this.frameBitsOut.length, AC97_BINARY.FRAME_OUT, byteString(this.frameBitsOut));
    if (this.frameBitsIn.length)
      this.putFrameBinary(0, this.frameBitsIn.length, AC97_BINARY.FRAME_IN, byteString(this.frameBitsIn));
  }

  private startFrame(ss: bigint): void {
    if (this.frameSamples) this.flushFrameBits();
    this.frameSamples = [ss];
    this.frameBitsOut = [];
    this.frameBitsIn = [];
    this.slotDataOut = [];
    this.slotDataIn = [];
    this.slotsOut = null;
    this.slotsIn = null;
  }

  private slotValid(slot: number, isOut: boolean): boolean {
    return (isOut ? this.slotsOut : this.slotsIn)?.[slot] === true;
  }

  private handleDummy(slot: number, bitOffset: number, bitCount: number, isOut: boolean, data: number): void {
    if (!this.slotValid(slot, isOut)) return;
    const tag = isOut ? AC97_ANN.SLOT_OUT_TAG : AC97_ANN.SLOT_IN_TAG;
    this.putFrame(bitOffset, bitCount, tag + slot, [nibbleText(data, bitCount)]);

    const raw = (data >> 4) & 0xffff;
    this.putFrameBinary(
      bitOffset,
      bitCount,
      isOut ? AC97_BINARY.SLOT_RAW_OUT : AC97_BINARY.SLOT_RAW_IN,
      Uint8Array.of(raw >>> 8, raw & 0xff),
    );
  }

  private handleTag(slot: number, bitOffset: number, bitCount: number, isOut: boolean, data: number): void {
    const tag = isOut ? AC97_ANN.SLOT_OUT_TAG : AC97_ANN.SLOT_IN_TAG;
    let offset = 0;

    const ready = bitField(data, bitCount, offset, 1);
    this.putFrame(bitOffset + offset, 1, tag, ready ? ['READY: 1', 'READY', 'RDY', 'R'] : ['ready: 0', 'rdy', '-']);
    offset++;

    const valid = bitField(data, bitCount, offset, 12);
    this.putFrame(bitOffset + offset, 12, tag, [`VALID: ${minWidthHex(valid, 3)}`, minWidthHex(valid, 3)]);
    const available = [true];
    for (let index = 0; index < 12; index++) available.push((valid & (1 << (11 - index))) !== 0);
    if (isOut) this.slotsOut = available;
    else this.slotsIn = available;
    offset += 12;

    if (bitField(data, bitCount, offset, 1) !== 0) this.putFrame(bitOffset + offset, 1, AC97_ANN.ERROR, ERROR_TEXTS);
    offset++;

    const codec = bitField(data, bitCount, offset, 2);
    this.putFrame(bitOffset + offset, 2, tag, [`CODEC: ${minWidthHex(codec, 1)}`, minWidthHex(codec, 1)]);
  }

  private handleCommandAddress(slot: number, bitOffset: number, bitCount: number, isOut: boolean, data: number): void {
    if (!this.slotValid(slot, isOut)) return;
    const tag = (isOut ? AC97_ANN.SLOT_OUT_TAG : AC97_ANN.SLOT_IN_TAG) + slot;
    let offset = 0;

    if (isOut) {
      const read = bitField(data, bitCount, offset, 1);
      this.putFrame(bitOffset, 1, tag, read ? ['READ', 'RD', 'R'] : ['WRITE', 'WR', 'W']);
    } else if (bitField(data, bitCount, offset, 1) !== 0) {
      this.putFrame(bitOffset, 1, AC97_ANN.ERROR, ERROR_TEXTS);
    }
    offset++;

    const address = bitField(data, bitCount, offset, 7);
    const addressText = nibbleText(address, 7);
    this.putFrame(bitOffset + offset, 7, tag, [`ADDR: ${addressText}`, addressText]);
    if (address & 1)
      this.putFrame(bitOffset + offset, 7, AC97_ANN.ERROR, ['odd register address', 'odd reg addr', 'odd addr', 'odd']);
    offset += 7;

    const request = bitField(data, bitCount, offset, 10);
    if (isOut) {
      if (request !== 0) this.putFrame(bitOffset + offset, 10, AC97_ANN.ERROR, ERROR_TEXTS);
    } else {
      const requestText = minWidthHex(request, 3);
      this.putFrame(bitOffset + offset, 10, tag, [`REQ: ${requestText}`, requestText]);
    }
    offset += 10;

    if (bitField(data, bitCount, offset, 2) !== 0) this.putFrame(bitOffset + offset, 2, AC97_ANN.ERROR, ERROR_TEXTS);
  }

  private handleCommandData(slot: number, bitOffset: number, bitCount: number, isOut: boolean, data: number): void {
    if (!this.slotValid(slot, isOut)) return;
    const tag = (isOut ? AC97_ANN.SLOT_OUT_TAG : AC97_ANN.SLOT_IN_TAG) + slot;
    const value = bitField(data, bitCount, 0, 16);
    const valueText = nibbleText(value, 16);
    this.putFrame(bitOffset, 16, tag, [`DATA: ${valueText}`, valueText]);
    if (bitField(data, bitCount, 16, 4) !== 0) this.putFrame(bitOffset + 16, 4, AC97_ANN.ERROR, ERROR_TEXTS);
  }

  private handleSlot(slot: number, dataOut: number | null, dataIn: number | null): void {
    const bitOffset = SLOT_STARTS[slot]!;
    const bitCount = SLOT_STARTS[slot + 1]! - bitOffset;

    for (const [isOut, data] of [
      [true, dataOut],
      [false, dataIn],
    ] as const) {
      if (data === null) continue;
      if (slot === 0) this.handleTag(slot, bitOffset, bitCount, isOut, data);
      else if (slot === 1) this.handleCommandAddress(slot, bitOffset, bitCount, isOut, data);
      else if (slot === 2) this.handleCommandData(slot, bitOffset, bitCount, isOut, data);
      else this.handleDummy(slot, bitOffset, bitCount, isOut, data);
    }
  }

  private handleBits(ss: bigint, es: bigint, bitOut: number | null, bitIn: number | null): void {
    if (bitOut !== null) this.put(ss, es, this.outAnn, [AC97_ANN.BITS_OUT, [String(bitOut)]]);
    if (bitIn !== null) this.put(ss, es, this.outAnn, [AC97_ANN.BITS_IN, [String(bitIn)]]);
    if (!this.frameSamples) return;

    this.frameSamples.push(es);
    const haveLength = this.frameSamples.length - 1;
    if (haveLength > FRAME_BITS) return;

    let slot = 0;
    if (bitOut !== null) {
      this.frameBitsOut.push(bitOut);
      slot = this.slotDataOut.length;
    }
    if (bitIn !== null) {
      this.frameBitsIn.push(bitIn);
      slot = this.slotDataIn.length;
    }

    if (haveLength !== SLOT_STARTS[slot + 1]) return;
    const previous = SLOT_STARTS[slot]!;
    let dataOut: number | null = null;
    let dataIn: number | null = null;

    if (bitOut !== null) {
      dataOut = 0;
      for (const bit of this.frameBitsOut.slice(previous, haveLength)) dataOut = dataOut * 2 + bit;
      this.slotDataOut.push(dataOut);
    }
    if (bitIn !== null) {
      dataIn = 0;
      for (const bit of this.frameBitsIn.slice(previous, haveLength)) dataIn = dataIn * 2 + bit;
      this.slotDataIn.push(dataIn);
    }

    const slotLength = haveLength - previous;
    if (dataOut !== null)
      this.put(this.frameSamples[previous]!, this.frameSamples[haveLength]!, this.outAnn, [
        AC97_ANN.SLOT_RAW_OUT,
        [nibbleText(dataOut, slotLength)],
      ]);
    if (dataIn !== null)
      this.put(this.frameSamples[previous]!, this.frameSamples[haveLength]!, this.outAnn, [
        AC97_ANN.SLOT_RAW_IN,
        [nibbleText(dataIn, slotLength)],
      ]);
    this.handleSlot(slot, dataOut, dataIn);
  }

  *decode(): LogicGenerator {
    const hasOut = this.hasChannel('out');
    const hasIn = this.hasChannel('in');
    if (!hasOut && !hasIn) throw new Error('Either SDATA_OUT or SDATA_IN (or both) are required.');

    const previousSync: Array<number | null> = [null, null, null];
    let pins = yield this.wait();
    if (pins[1] === 0) {
      previousSync[2] = pins[0]!;
      pins = yield this.wait({ clk: 'r' });
    }
    let bitStart = this.samplenum;

    while (true) {
      pins = yield this.wait({ clk: 'f' });
      const sync = pins[0]!;
      const bitOut = hasOut ? pins[2]! : null;
      const bitIn = hasIn ? pins[3]! : null;
      previousSync.shift();
      previousSync.push(sync);
      yield this.wait({ clk: 'r' });
      if (previousSync[0] === 0 && previousSync[1] === 1) this.startFrame(bitStart);
      this.handleBits(bitStart, this.samplenum, bitOut, bitIn);
      bitStart = this.samplenum;
    }
  }

  onEof(): void {
    if (this.frameSamples) this.flushFrameBits();
  }
}

export default Ac97Decoder;
