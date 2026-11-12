import { descriptor } from './descriptor.js';
import { bitpack } from '../common.js';
import { Decoder, generatorPlugin, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator, WaitCondition } from '../../libhakeidecode/index.js';

export interface CaliperOptions {
  timeout_ms: number;
  unit: string;
  changes: string;
}

export interface CaliperMeasurement {
  readonly value: number;
  readonly unit: 'mm' | 'in';
  readonly text: string;
  readonly short: string;
}

export const CALIPER_ANN = Object.freeze({
  MEASUREMENT: 0,
  WARNING: 1,
});

const MILLIMETRES_PER_INCH = 25.4;

function roundDecimal(value: number, places: number): number {
  const factor = 10 ** places;
  const scaled = value * factor;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const rounded = fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower + (Math.abs(lower % 2) === 1 ? 1 : 0);
  return rounded / factor;
}

export function formatCaliperNumber(value: number): string {
  if (Object.is(value, -0)) return '-0.0';
  let text = String(value);
  const exponent = text.search(/[eE]/);
  if (exponent >= 0) {
    const coefficient = text.slice(0, exponent);
    const power = text.slice(exponent + 1);
    const sign = power.startsWith('-') ? '-' : '+';
    const digits = power.replace(/^[+-]/, '').padStart(2, '0');
    return `${coefficient}e${sign}${digits}`;
  }
  if (!text.includes('.')) text += '.0';
  return text;
}

export function caliperMeasurement(
  raw: number,
  negative: boolean,
  wireInch: boolean,
  wantedUnit: string,
): CaliperMeasurement {
  let value = negative ? -raw : raw;
  let inch = wireInch;
  if (inch) {
    value /= 2000;
    if (wantedUnit === 'mm') {
      value *= MILLIMETRES_PER_INCH;
      inch = false;
    }
  } else {
    value /= 100;
    if (wantedUnit === 'inch') {
      value = roundDecimal(value / MILLIMETRES_PER_INCH, 4);
      inch = true;
    }
  }
  const unit = inch ? 'in' : 'mm';
  const short = formatCaliperNumber(value);
  return { value, unit, text: short + unit, short };
}

export class CaliperDecoder extends Decoder<CaliperOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outAnn = -1;
  private ss: bigint | null = null;
  private es: bigint | null = null;
  private numberBits: number[] = [];
  private flagsBits: number[] = [];

  constructor(options: Partial<CaliperOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.ss = null;
    this.es = null;
    this.numberBits = [];
    this.flagsBits = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  *decode(): LogicGenerator {
    const timeoutMs = this.options.timeout_ms;
    if (timeoutMs && !this.samplerate) throw new Error('Cannot decode without samplerate.');
    const conditions: WaitCondition[] = [{ clk: 'r' }];
    if (timeoutMs) conditions.push({ skip: Math.round(timeoutMs * ((this.samplerate ?? 0) / 1000)) });

    const wantedUnit = this.options.unit;
    const showAll = this.options.changes === 'no';
    let lastValue: number | null = null;
    let lastUnit = '';

    while (true) {
      yield this.wait(conditions);
      if (timeoutMs && !(this.matched?.[0] ?? false)) {
        const count = this.numberBits.length + this.flagsBits.length;
        if (count) {
          this.put(this.ss ?? this.samplenum, this.samplenum, this.outAnn, [
            CALIPER_ANN.WARNING,
            [`timeout with ${count} bits in buffer`, `timeout (${count} bits)`, 'timeout'],
          ]);
        }
        this.reset();
        continue;
      }

      const data = Number(this.channelValue('data'));
      if (this.ss === null) this.ss = this.samplenum;
      this.es = this.samplenum;
      if (this.numberBits.length < 16) {
        this.numberBits.push(data);
        continue;
      }
      if (this.flagsBits.length < 8) {
        this.flagsBits.push(data);
        if (this.flagsBits.length < 8) continue;
      }

      const raw = bitpack(this.numberBits);
      const measurement = caliperMeasurement(raw, Boolean(this.flagsBits[4]), Boolean(this.flagsBits[7]), wantedUnit);
      if (showAll || measurement.value !== lastValue || measurement.unit !== lastUnit) {
        this.put(this.ss ?? this.samplenum, this.es ?? this.samplenum, this.outAnn, [
          CALIPER_ANN.MEASUREMENT,
          [measurement.text, measurement.short],
        ]);
        lastValue = measurement.value;
        lastUnit = measurement.unit;
      }
      this.reset();
    }
  }
}

export const caliperPlugin: DecoderPlugin<any, any> = {
  decoder: CaliperDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(CaliperDecoder).createEngine(context),
};

export default CaliperDecoder;
