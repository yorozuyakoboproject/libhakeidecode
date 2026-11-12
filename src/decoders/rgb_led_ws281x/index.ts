import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface Ws281xOptions {
  wireorder: 'BGR' | 'BRG' | 'GBR' | 'GRB' | 'RBG' | 'RGB' | 'RWBG' | 'RGBW';
  textorder: 'wire' | 'RGB[W]' | 'RGB' | 'RGBW' | 'RGWB';
}

type WireComponent = 'r' | 'g' | 'b' | 'w';
type BitRecord = readonly [value: number, ss: bigint, es: bigint];

const ANN_BIT = 0;
const ANN_RESET = 1;
const ANN_RGB = 2;
const ANN_RED = 3;
const ANN_GREEN = 4;
const ANN_BLUE = 5;
const ANN_WHITE = 6;

export class RgbLedWs281xDecoder extends Decoder<Ws281xOptions> {
  static descriptor = descriptor;
  private samplerate: number | null = null;
  private outAnn = -1;
  private bits: BitRecord[] = [];
  private wireformat: WireComponent[] = [];
  private needBits = 0;
  private textorder = 'RGB[W]';

  constructor(options: Partial<Ws281xOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.bits = [];
    this.wireformat = [];
    this.needBits = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private hex(value: number): string {
    return value.toString(16).padStart(2, '0');
  }

  private handleBits(): void {
    if (this.bits.length < this.needBits) return;
    const packetStart = this.bits[0]![1],
      packetEnd = this.bits[this.bits.length - 1]![2];
    let red = 0,
      green = 0,
      blue = 0;
    let white: number | null = null;
    const components: { ss: bigint; es: bigint; classIndex: number; value: number; text: string }[] = [];
    for (let index = 0; index < this.wireformat.length; index++) {
      const componentBits = this.bits.slice(index * 8, index * 8 + 8),
        componentStart = componentBits[0]![1],
        componentEnd = componentBits[componentBits.length - 1]![2];
      let value = 0;
      for (const item of componentBits) value = (value << 1) | (item[0] & 1);
      const name = this.wireformat[index]!;
      const classIndex = name === 'r' ? ANN_RED : name === 'g' ? ANN_GREEN : name === 'b' ? ANN_BLUE : ANN_WHITE;
      components.push({ ss: componentStart, es: componentEnd, classIndex, value, text: this.hex(value) });
      if (name === 'r') red = value;
      else if (name === 'g') green = value;
      else if (name === 'b') blue = value;
      else white = value;
    }

    const whiteText = white === null ? '' : this.hex(white);
    let rgbText: string;
    if (this.textorder === 'wire') {
      rgbText = '#' + components.map((component) => component.text).join('');
    } else if (this.textorder === 'RGB[W]') {
      rgbText = `#${this.hex(red)}${this.hex(green)}${this.hex(blue)}${whiteText}`;
    } else if (this.textorder === 'BGR') {
      rgbText = `#${this.hex(blue)}${this.hex(green)}${this.hex(red)}`;
    } else if (this.textorder === 'BRG') {
      rgbText = `#${this.hex(blue)}${this.hex(red)}${this.hex(green)}`;
    } else if (this.textorder === 'GBR') {
      rgbText = `#${this.hex(green)}${this.hex(blue)}${this.hex(red)}`;
    } else if (this.textorder === 'GRB') {
      rgbText = `#${this.hex(green)}${this.hex(red)}${this.hex(blue)}`;
    } else if (this.textorder === 'RBG') {
      rgbText = `#${this.hex(red)}${this.hex(blue)}${this.hex(green)}`;
    } else if (this.textorder === 'RGB') {
      rgbText = `#${this.hex(red)}${this.hex(green)}${this.hex(blue)}`;
    } else if (this.textorder === 'RGBW') {
      rgbText = `#${this.hex(red)}${this.hex(green)}${this.hex(blue)}${this.hex(white ?? 0)}`;
    } else {
      rgbText = `#${this.hex(red)}${this.hex(green)}${this.hex(white ?? 0)}${this.hex(blue)}`;
    }

    for (const component of components)
      this.put(component.ss, component.es, this.outAnn, [component.classIndex, [component.text]]);
    if (rgbText) this.put(packetStart, packetEnd, this.outAnn, [ANN_RGB, [rgbText]]);
    this.bits = [];
  }

  private handleBit(ss: bigint, es: bigint, value: number, late = false): void {
    if (!late) this.put(ss, es, this.outAnn, [ANN_BIT, [String(value)]]);
    this.bits.push([value, ss, es]);
    this.handleBits();
    if (late) this.put(ss, es, this.outAnn, [ANN_BIT, [String(value)]]);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    this.wireformat = [...this.options.wireorder.toLowerCase()].filter(
      (value): value is WireComponent => value === 'r' || value === 'g' || value === 'b' || value === 'w',
    );
    this.needBits = this.wireformat.length * 8;
    this.textorder = this.options.textorder;
    const minimumHighSamples = BigInt(Math.ceil((this.samplerate * 580) / 1_000_000_000));
    const bitValue = (duty: bigint): number => (duty >= minimumHighSamples ? 1 : 0);
    const samples50 = Math.round(this.samplerate * 50e-6);
    let ssBit: bigint | null = null,
      invBit: bigint | null = null,
      esBit: bigint | null = null,
      checkReset = false;

    yield this.wait({ din: 'l' });
    invBit = this.samplenum;
    while (true) {
      const pins = yield this.wait([{ din: 'r' }, { din: 'f' }, { skip: samples50 + 1 }]);
      void pins;
      const matched = this.matched ?? [];
      if (checkReset && matched[2] === true) {
        esBit = invBit;
        const ssReset = invBit,
          esReset = this.samplenum;
        if (ssBit !== null && invBit !== null && esBit !== null) {
          const duty = invBit - ssBit;
          this.handleBit(ssBit, invBit, bitValue(duty), true);
        }
        if (ssReset !== null && esReset !== null)
          this.put(ssReset, esReset, this.outAnn, [ANN_RESET, ['RESET', 'RST', 'R']]);
        checkReset = false;
        this.bits = [];
        ssBit = invBit = esBit = null;
      }
      if (matched[0] === true) {
        checkReset = false;
        if (ssBit !== null && invBit !== null) {
          esBit = this.samplenum;
          const duty = invBit - ssBit;
          this.handleBit(ssBit, esBit, bitValue(duty));
        }
        ssBit = this.samplenum;
        invBit = null;
        esBit = null;
      }
      if (matched[1] === true) {
        checkReset = true;
        invBit = this.samplenum;
      }
    }
  }
}

export default RgbLedWs281xDecoder;
