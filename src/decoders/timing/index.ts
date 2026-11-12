import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitPredicate } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface TimingOptions {
  avg_period: number;
  edge: string;
  delta: string;
  format: string;
}

export function normalizeTime(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1) return `${value.toFixed(3)} s  (${(1 / value).toFixed(3)} Hz)`;
  if (magnitude >= 0.001) {
    if (1 / value / 1000 < 1) return `${(value * 1000).toFixed(3)} ms (${(1 / value).toFixed(3)} Hz)`;
    return `${(value * 1000).toFixed(3)} ms (${(1 / value / 1000).toFixed(3)} kHz)`;
  }
  if (magnitude >= 0.000001) {
    if (1 / value / 1e6 < 1) return `${(value * 1e6).toFixed(3)} μs (${(1 / value / 1000).toFixed(3)} kHz)`;
    return `${(value * 1e6).toFixed(3)} μs (${(1 / value / 1e6).toFixed(3)} MHz)`;
  }
  if (magnitude >= 1e-9) {
    if (1 / value / 1e9) return `${(value * 1e9).toFixed(3)} ns (${(1 / value / 1e6).toFixed(3)} MHz)`;
    return `${(value * 1e9).toFixed(3)} ns (${(1 / value / 1e9).toFixed(3)} GHz)`;
  }
  return value.toFixed(6);
}

export function terseTimes(value: number, format: string): string[] {
  if (format === 'full') return [normalizeTime(value)];
  if (format === 'samples') return [String(Math.trunc(value))];

  let scale: number | null = null;
  let unit = '';
  if (format === 'terse-auto') {
    const magnitude = Math.abs(value);
    if (magnitude >= 1) {
      scale = 1;
      unit = 's';
    } else if (magnitude >= 1e-3) {
      scale = 1e3;
      unit = 'ms';
    } else if (magnitude >= 1e-6) {
      scale = 1e6;
      unit = 'us';
    } else if (magnitude >= 1e-9) {
      scale = 1e9;
      unit = 'ns';
    } else if (magnitude >= 1e-12) {
      scale = 1e12;
      unit = 'ps';
    }
  } else if (format === 'terse-s') scale = 1;
  else if (format === 'terse-ms') scale = 1e3;
  else if (format === 'terse-us') scale = 1e6;
  else if (format === 'terse-ns') scale = 1e9;
  else if (format === 'terse-ps') scale = 1e12;

  if (scale !== null) {
    const scaled = value * scale;
    return [`${scaled.toFixed(0)}${unit}`, scaled.toFixed(0)];
  }
  return [value.toFixed(6)];
}

function edgePredicate(edge: string): WaitPredicate {
  if (edge === 'rising') return 'r';
  if (edge === 'falling') return 'f';
  return 'e';
}

export class TimingDecoder extends Decoder<TimingOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private samplerate = 0;

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    const averagePeriod = this.options.avg_period;
    const showDelta = this.options.delta === 'yes';
    const format = this.options.format;
    const recent: number[] = [];
    let start: bigint | null = null;
    let lastTime: number | null = null;

    while (true) {
      yield this.wait({ data: edgePredicate(this.options.edge) });
      if (start === null) {
        start = this.samplenum;
        continue;
      }
      const end = this.samplenum;
      const samples = Number(end - start);
      const time = samples / this.samplerate;

      if (format === 'full') this.put(start, end, this.outAnn, [0, [normalizeTime(time)]]);
      else if (format === 'samples') this.put(start, end, this.outAnn, [1, terseTimes(samples, format)]);
      else this.put(start, end, this.outAnn, [1, terseTimes(time, format)]);

      if (averagePeriod > 0) {
        if (time > 0) recent.push(time);
        if (recent.length > averagePeriod) recent.shift();
        const average = recent.reduce((sum, value) => sum + value, 0) / recent.length;
        this.put(start, end, this.outAnn, [2, [normalizeTime(average)]]);
      }
      if (lastTime && showDelta) this.put(start, end, this.outAnn, [3, [normalizeTime(time - lastTime)]]);

      lastTime = time;
      start = end;
    }
  }
}

export default TimingDecoder;
