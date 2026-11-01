import { descriptor } from './descriptor.js';
import {
  Decoder,
  generatorPlugin,
  OUTPUT_ANN,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';
import type { DecodeFrame } from '../definition.js';

export interface WS2812Options {
  wireorder: string;
  textorder: string;
}
export interface WS2812Frame extends DecodeFrame {
  index: number;
  r: number;
  g: number;
  b: number;
  w: number | null;
  text: string;
}
export type WS2812ProtocolPacket = ['PIXEL', frame: Omit<WS2812Frame, 'ss' | 'es'>] | ['INCOMPLETE', bits: number];
export const WS2812_ANN = Object.freeze({ PIXEL: 0, WARNING: 1 });

function colorText(values: Readonly<Record<'R' | 'G' | 'B' | 'W', number>>, order: string, hasWhite: boolean) {
  let textOrder = order
    .split('')
    .filter((channel) => hasWhite || channel !== 'W')
    .join('');
  if (hasWhite && !textOrder.includes('W')) textOrder += 'W';
  return textOrder
    .split('')
    .map(
      (channel) =>
        channel + ':0x' + values[channel as 'R' | 'G' | 'B' | 'W'].toString(16).padStart(2, '0').toUpperCase(),
    )
    .join(' ');
}

export class WS2812Decoder extends Decoder<WS2812Options> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outProtocol = -1;
  private outAnn = -1;
  private bits: number[] = [];
  private highSamples: number | null = null;
  private pixelIndex = 0;
  private pixelStart: bigint | null = null;

  constructor(options: Partial<WS2812Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.bits = [];
    this.highSamples = null;
    this.pixelIndex = 0;
    this.pixelStart = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'ws2812');
    this.outAnn = this.register(OUTPUT_ANN);
    const wire = /^[RGBW]{3,4}$/.test(this.options.wireorder) ? this.options.wireorder : '';
    if (!wire || new Set(wire).size !== wire.length || ![3, 4].includes(wire.length))
      throw new Error('Invalid WS2812 wire order.');
    if (
      !/^[RGBW]{3,4}$/.test(this.options.textorder) ||
      new Set(this.options.textorder).size !== this.options.textorder.length
    )
      throw new Error('Invalid WS2812 text order.');
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private get bitCount(): number {
    return this.options.wireorder.length * 8;
  }

  private pushBit(value: number): void {
    this.bits.push(value);
    if (this.bits.length === this.bitCount) this.emitPixel();
  }

  private classify(high: number, low: number): number {
    return high / (high + low) >= 0.5 ? 1 : 0;
  }

  private classifyHighOnly(high: number): number {
    return high >= (this.samplerate ?? 1) * 0.6e-6 ? 1 : 0;
  }

  private emitPixel(): void {
    const values = { R: 0, G: 0, B: 0, W: 0 };
    let cursor = 0;
    for (const channel of this.options.wireorder) {
      let value = 0;
      for (let bit = 0; bit < 8; bit++) value = (value << 1) | this.bits[cursor++]!;
      values[channel as 'R' | 'G' | 'B' | 'W'] = value;
    }
    const hasWhite = this.options.wireorder.includes('W'),
      text = colorText(values, this.options.textorder, hasWhite),
      frame = {
        index: this.pixelIndex++,
        r: values.R,
        g: values.G,
        b: values.B,
        w: hasWhite ? values.W : null,
        text,
      };
    const ss = this.pixelStart ?? this.samplenum;
    this.put(ss, this.samplenum, this.outAnn, [WS2812_ANN.PIXEL, ['Pixel', String(frame.index), text]]);
    this.put(ss, this.samplenum, this.outProtocol, ['PIXEL', frame]);
    this.bits = [];
    this.pixelStart = null;
  }

  private incomplete(): void {
    const bits = this.bits.length;
    if (!bits) return;
    this.put(this.samplenum, this.samplenum, this.outAnn, [
      WS2812_ANN.WARNING,
      ['Incomplete pixel', String(bits)],
      bits,
    ]);
    this.put(this.samplenum, this.samplenum, this.outProtocol, ['INCOMPLETE', bits]);
    this.bits = [];
    this.pixelStart = null;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let pins = yield this.wait();
    let level = Number(pins[0]),
      previousEdge = this.samplenum;
    const resetSamples = Math.max(2, Math.round(this.samplerate * 50e-6));
    while (true) {
      pins = yield this.wait({ din: 'e' });
      const now = this.samplenum,
        next = Number(pins[0]),
        duration = Number(now - previousEdge);
      if (level === 1) {
        if (duration > this.samplerate * 5e-6) {
          this.highSamples = null;
          this.incomplete();
        } else this.highSamples = duration;
      } else if (this.highSamples !== null) {
        if (duration >= resetSamples) this.pushBit(this.classifyHighOnly(this.highSamples));
        else this.pushBit(this.classify(this.highSamples, duration));
        this.highSamples = null;
        if (duration >= resetSamples) this.incomplete();
      } else if (duration >= resetSamples) this.incomplete();
      if (next === 1 && this.bits.length === 0 && this.pixelStart === null) this.pixelStart = now;
      level = next;
      previousEdge = now;
    }
  }

  onEof(): void {
    if (this.highSamples !== null) {
      this.pushBit(this.classifyHighOnly(this.highSamples));
      this.highSamples = null;
    }
    this.incomplete();
  }
}

export const ws2812Plugin: DecoderPlugin<any, any> = {
  decoder: WS2812Decoder,
  descriptor,
  createEngine: (context) => generatorPlugin(WS2812Decoder).createEngine(context),
};

export default WS2812Decoder;
