import { descriptor } from './descriptor.js';
import { bitpack } from '../common.js';
import { Decoder, generatorPlugin, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';

export interface SdqOptions {
  bitrate: number;
}

export const SDQ_ANN = Object.freeze({
  BIT: 0,
  BYTE: 1,
  BREAK: 2,
});

export class SdqDecoder extends Decoder<SdqOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outAnn = -1;
  private bitWidth = 0;
  private startsample = 0n;
  private bytepos = 0n;
  private bits: number[] = [];

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private putBit(bit: number): void {
    this.bits.push(bit);
    this.put(this.startsample, this.startsample + BigInt(Math.trunc(this.bitWidth)), this.outAnn, [
      SDQ_ANN.BIT,
      [`Bit: ${bit}`, String(bit)],
    ]);
    if (this.bits.length === 8) {
      const value = bitpack(this.bits);
      this.put(this.bytepos, this.startsample + BigInt(Math.trunc(this.bitWidth)), this.outAnn, [
        SDQ_ANN.BYTE,
        [`Byte: 0x${value.toString(16).padStart(2, '0')}`, `0x${value.toString(16).padStart(2, '0')}`],
      ]);
      this.bits = [];
      this.bytepos = 0n;
    }
  }

  private putBreak(): void {
    this.put(this.startsample, this.samplenum, this.outAnn, [SDQ_ANN.BREAK, ['Break', 'BR']]);
    this.bits = [];
    this.startsample = this.samplenum;
    this.bytepos = 0n;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    this.bitWidth = this.samplerate / this.options.bitrate;
    const halfBitWidth = this.bitWidth / 2;
    const breakThreshold = this.bitWidth * 1.2;

    yield this.wait({ sdq: 'h' });
    while (true) {
      yield this.wait({ sdq: 'f' });
      this.startsample = this.samplenum;
      if (this.bytepos === 0n) this.bytepos = this.samplenum;
      yield this.wait({ sdq: 'r' });

      const delta = Number(this.samplenum - this.startsample);
      if (delta > breakThreshold) this.putBreak();
      else if (delta > halfBitWidth) this.putBit(0);
      else this.putBit(1);
    }
  }
}

export const sdqPlugin: DecoderPlugin<any, any> = {
  decoder: SdqDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(SdqDecoder).createEngine(context),
};

export default SdqDecoder;
