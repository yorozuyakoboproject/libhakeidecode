import { sampleRatio } from '../libhakei/sample-index.js';

import { Decoder, OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_META, SRD_CONF_SAMPLERATE, registry } from '../libhakeidecode/index.js';
import type { DecoderContext, DecoderDescriptor, LogicGenerator } from '../libhakeidecode/index.js';
export interface PWMOptions {   polarity: string; }
export const PWM_ANN = Object.freeze({ DUTY_CYCLE: 0, PERIOD: 1, FREQUENCY: 2 });
function fixed(value: number, digits: number): string {
  if ((value * 10 ** digits) % 1 !== 0.5) return value.toFixed(digits);
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift); else denominator <<= BigInt(-shift);
  let rounded = numerator / denominator; const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n)) rounded++;
  const text = rounded.toString().padStart(digits + 1, '0');
  return digits ? text.slice(0, -digits) + '.' + text.slice(-digits) : text;
}

export function formatPWMDuty(percent: number): string { return fixed(percent, 6) + '%'; }
export function formatPWMPeriod(seconds: number): string {
  const [scale, unit] = seconds === 0 || seconds >= 1 ? [1, 's'] : seconds <= 1e-12 ? [1e15, 'fs']
    : seconds <= 1e-9 ? [1e12, 'ps'] : seconds <= 1e-6 ? [1e9, 'ns'] : seconds <= 1e-3 ? [1e6, 'μs'] : [1e3, 'ms'];
  return fixed(seconds * scale, 1) + ' ' + unit;
}
export function formatPWMFrequency(seconds: number): string {
  const frequency = 1 / seconds;
  const [scale, unit] = frequency >= 1e15 ? [1e15, 'PHz'] : frequency >= 1e12 ? [1e12, 'THz']
    : frequency >= 1e9 ? [1e9, 'GHz'] : frequency >= 1e6 ? [1e6, 'MHz'] : frequency >= 1e3 ? [1e3, 'kHz'] : [1, 'Hz'];
  return seconds ? fixed(frequency / scale, 3) + ' ' + unit : 'invalid';
}
export class PWMDecoder extends Decoder<PWMOptions> {
  static descriptor: DecoderDescriptor = {
    apiVersion: 3, id: 'pwm', name: 'PWM', longname: 'Pulse-width modulation',
    desc: 'Analog level encoded in duty cycle percentage.',
    inputs: ['logic'], outputs: [], tags: ['Encoding'],
    channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
    options: [{ id: 'polarity', desc: 'Polarity', default: 'active-high', values: ['active-low', 'active-high'] }],
    annotations: [['duty-cycle', 'Duty cycle'], ['period', 'Period'], ['frequency', 'Frequency']],
    annotationRows: [['duty-cycle-vals', 'Duty cycles', [0]], ['periods', 'Periods', [1]], ['frequency-vals', 'Frequencies', [2]]],
    binary: [['raw', 'RAW file']],
  };
  samplerate: number | null = null;
  ss_block: bigint | null = null;
  es_block: bigint | null = null;
  first_samplenum = 0n;
  private out_ann = -1;
  private out_binary = -1;
  private out_average = -1;
  constructor(options: Partial<PWMOptions> = {}) { super(options); this.reset(); }
  reset(): void { this.samplerate = null; this.ss_block = this.es_block = null; this.first_samplenum = 0n; }
  metadata(key: number, value: number): void { if (key === SRD_CONF_SAMPLERATE) this.samplerate = value; }
  start(ctx: DecoderContext): void {
    super.start(ctx); this.out_ann = this.register(OUTPUT_ANN); this.out_binary = this.register(OUTPUT_BINARY);
    this.out_average = this.register(OUTPUT_META, undefined, ['float', 'Average', 'PWM base (cycle) frequency']);
  }
  private putPeriod(seconds: number): void {
    this.put(this.ss_block!, this.es_block!, this.out_ann, [PWM_ANN.PERIOD, [formatPWMPeriod(seconds)]]);
  }
  private putFrequency(seconds: number): void {
    this.put(this.ss_block!, this.es_block!, this.out_ann, [PWM_ANN.FREQUENCY, [formatPWMFrequency(seconds)]]);
  }
  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let cycles = 0, totalPercent = 0;
    yield this.wait({ 0: this.options.polarity === 'active-low' ? 'f' : 'r' });
    this.first_samplenum = this.samplenum;
    while (true) {
      const start = this.samplenum;
      yield this.wait({ 0: 'e' }); const middle = this.samplenum;
      yield this.wait({ 0: 'e' }); this.ss_block = start; this.es_block = this.samplenum;
      const period = this.samplenum - start, ratio = sampleRatio(middle - start, period), percent = ratio * 100;
      this.put(start, this.samplenum, this.out_ann, [PWM_ANN.DUTY_CYCLE, [formatPWMDuty(percent)]]);
      this.put(start, this.samplenum, this.out_binary, [0, Uint8Array.of(Math.trunc(ratio * 256))]);
      const seconds = Number(period) / this.samplerate; this.putPeriod(seconds); this.putFrequency(seconds);
      totalPercent += percent; cycles++;
      this.put(this.first_samplenum, this.es_block, this.out_average, totalPercent / cycles);
    }
  }
}
registry.register(PWMDecoder);
