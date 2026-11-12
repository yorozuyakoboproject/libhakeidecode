import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface Tlc5620Options {
  vref_a: number;
  vref_b: number;
  vref_c: number;
  vref_d: number;
}

interface BitSample {
  readonly value: number;
  readonly sample: bigint;
}

const DAC_NAMES = ['DACA', 'DACB', 'DACC', 'DACD'] as const;

export class Tlc5620Decoder extends Decoder<Tlc5620Options> {
  static descriptor = descriptor;

  private outAnn = -1;
  private bits: BitSample[] = [];
  private ssDacFirst: bigint | null = null;
  private ssDac = 0n;
  private ssGain = 0n;
  private ssValue = 0n;
  private esValue = 0n;
  private clockWidth = 0n;
  private dacSelect = 'DACA';
  private gain = 1;
  private dacValue = 0;
  private dacValues: (number | null)[] = [null, null, null, null];
  private gains: (number | null)[] = [null, null, null, null];
  private ldacLevel = 1;

  override reset(): void {
    this.bits = [];
    this.ssDacFirst = null;
    this.ssDac = this.ssGain = 0n;
    this.ssValue = this.esValue = this.clockWidth = 0n;
    this.dacSelect = 'DACA';
    this.gain = 1;
    this.dacValue = 0;
    this.dacValues = [null, null, null, null];
    this.gains = [null, null, null, null];
    this.ldacLevel = 1;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.reset();
  }

  *decode(): LogicGenerator {
    while (true) {
      const pins = yield this.wait([{ clk: 'f' }, { load: 'f' }, { ldac: 'f' }]);
      const matched = this.matched ?? [];
      this.ldacLevel = Number(pins[3]);
      if (matched[0]) this.handleBit(Number(pins[1]));
      if (matched[1]) this.handleLoad();
      if (matched[2]) this.handleLdac();
    }
  }

  private vref(name: string): number {
    switch (name[3]) {
      case 'A':
        return this.options.vref_a;
      case 'B':
        return this.options.vref_b;
      case 'C':
        return this.options.vref_c;
      default:
        return this.options.vref_d;
    }
  }

  private handleBit(value: number): void {
    this.bits.push({ value: value & 1, sample: this.samplenum });
  }

  private handleBits(): boolean {
    if (this.bits.length > 11) this.bits = this.bits.slice(-11);
    if (this.bits.length < 11) {
      let ss = this.samplenum;
      let es = this.samplenum;
      if (this.bits.length >= 2) {
        ss = this.bits[0]!.sample;
        es = this.bits.at(-1)!.sample + (this.bits[1]!.sample - this.bits[0]!.sample);
        if (es < ss) es = ss;
      }
      this.put(ss, es, this.outAnn, [9, ['Command too short']]);
      this.bits = [];
      return false;
    }

    const bits = this.bits;
    this.ssDac = bits[0]!.sample;
    this.ssGain = bits[2]!.sample;
    this.ssValue = bits[3]!.sample;
    this.clockWidth = this.ssValue - this.ssGain;
    this.esValue = bits[10]!.sample + this.clockWidth;
    this.ssDacFirst ??= this.ssDac;

    const dacIndex = (bits[0]!.value << 1) | bits[1]!.value;
    const dac = DAC_NAMES[dacIndex]!;
    this.dacSelect = dac;
    this.put(this.ssDac, this.ssGain, this.outAnn, [
      0,
      [`DAC select: ${dac}`, `DAC sel: ${dac}`, `DAC: ${dac}`, `D: ${dac}`, dac, dac[3]],
    ]);

    this.gain = 1 + bits[2]!.value;
    this.put(this.ssGain, this.ssValue, this.outAnn, [1, [`Gain: x${this.gain}`, `G: x${this.gain}`, `x${this.gain}`]]);

    this.dacValue = 0;
    for (let index = 3; index < 11; index++) this.dacValue = (this.dacValue << 1) | bits[index]!.value;
    this.put(this.ssValue, this.esValue, this.outAnn, [
      2,
      [
        `DAC value: ${this.dacValue}`,
        `Value: ${this.dacValue}`,
        `Val: ${this.dacValue}`,
        `V: ${this.dacValue}`,
        `${this.dacValue}`,
      ],
    ]);

    for (let index = 1; index < 11; index++)
      this.put(bits[index - 1]!.sample, bits[index]!.sample, this.outAnn, [5, [`${bits[index - 1]!.value}`]]);
    this.put(bits[10]!.sample, bits[10]!.sample + this.clockWidth, this.outAnn, [5, [`${bits[10]!.value}`]]);

    this.bits = [];
    return true;
  }

  private handleLoad(): void {
    if (!this.handleBits()) return;
    this.put(this.samplenum, this.samplenum, this.outAnn, [3, ['Falling edge on LOAD', 'LOAD fall', 'F']]);
    const voltage = this.vref(this.dacSelect) * (this.dacValue / 256) * this.gain;
    const text = `${voltage.toFixed(2)}V`;
    if (this.ldacLevel === 0) {
      this.put(this.ssDac, this.esValue, this.outAnn, [
        7,
        [`Setting ${this.dacSelect} voltage to ${text}`, `${this.dacSelect}=${text}`],
      ]);
    } else {
      this.put(this.ssDac, this.esValue, this.outAnn, [
        6,
        [`Setting ${this.dacSelect} register value to ${text}`, `${this.dacSelect}=${text}`],
      ]);
    }
    const index = this.dacSelect.charCodeAt(3) - 65;
    this.dacValues[index] = this.dacValue;
    this.gains[index] = this.gain;
  }

  private handleLdac(): void {
    this.put(this.samplenum, this.samplenum, this.outAnn, [4, ['Falling edge on LDAC', 'LDAC fall', 'LDAC', 'L']]);
    if (this.ssDacFirst === null) return;

    const values = DAC_NAMES.map((name, index) => {
      const value = this.dacValues[index];
      if (value === null) return '?';
      return `${(this.vref(name) * (value / 256) * this.gains[index]!).toFixed(2)}V`;
    });
    const full = DAC_NAMES.map((name, index) => `${name}=${values[index]}`).join(' ');
    const short = values.map((value, index) => `${'ABCD'[index]}=${value}`).join(' ');
    this.put(this.ssDacFirst, this.samplenum, this.outAnn, [8, [`Updating voltages: ${full}`, full, short]]);
    this.ssDacFirst = null;
  }
}

export default Tlc5620Decoder;
