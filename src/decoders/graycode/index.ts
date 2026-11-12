import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitPredicate } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface GraycodeOptions {
  edges: number;
  avg_period: number;
}

const MAX_CHANNELS = 8;
const PREFIXES: Readonly<Record<number, string>> = {
  [-9]: 'n',
  [-6]: 'µ',
  [-3]: 'm',
  0: '',
  3: 'k',
  6: 'M',
  9: 'G',
};

export function grayDecode(value: number): number {
  let result = value;
  result ^= result >>> 8;
  result ^= result >>> 4;
  result ^= result >>> 2;
  result ^= result >>> 1;
  return result & 0xff;
}

export function grayEncode(value: number): number {
  return (value ^ (value >>> 1)) & 0xff;
}

export function prefixFormat(value: number, minimumExponent?: number): string {
  const sign = value > 0 ? 1 : value < 0 ? -1 : 0;
  value = Math.abs(value);
  let position = value ? Math.log10(value) : 0;
  let exponent = Math.floor(position / 3) * 3;
  const places = Math.trunc(3 - position);
  value = Math.floor(value * 10 ** places) * 10 ** -places;
  if (minimumExponent !== undefined && exponent < minimumExponent) exponent = minimumExponent;
  value *= 10 ** -exponent;
  position -= exponent;
  return `${(sign * value).toFixed(2 - Math.trunc(position))} ${PREFIXES[exponent] ?? `e${exponent}`}`;
}

export function grayIncrementText(value: number, steps: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) === steps >>> 1) return '±π';
  return value > 0 ? `+${value}` : String(value);
}

export function grayTurnCount(count: number, edges: number): number {
  return edges ? Math.floor(count / edges) : count;
}

export function grayDelta(previous: number, current: number, steps: number): number {
  const span = (steps >>> 1) - 1;
  return ((((current - previous + span) % steps) + steps) % steps) - span;
}

export class GraycodeDecoder extends Decoder<GraycodeOptions> {
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

  private putValue(classIndex: number, ss: bigint, es: bigint, text: string): void {
    this.put(ss, es, this.outAnn, [classIndex, [text]]);
  }

  *decode(): LogicGenerator {
    const connected = Array.from({ length: MAX_CHANNELS }, (_, index) => this.hasChannel(`d${index}`));
    const channelCount = connected.filter(Boolean).length;
    if (!channelCount) throw new Error('Need at least one data channel.');
    if (connected.some((present, index) => present !== index < channelCount))
      throw new Error('Assigned channels need to be contiguous');

    const steps = 1 << channelCount;
    const conditions = connected.slice(0, channelCount).map((_, index) => ({ [`d${index}`]: 'e' as WaitPredicate }));

    let pins = yield this.wait({ skip: 0 });
    let sample = this.samplenum;
    let previous = sample;
    let phase = grayDecode(packBits(pins, channelCount));
    let phaseStart = sample;
    let increment: number | null = null;
    let incrementStart = sample;
    let count = 0;
    let countStart = sample;
    let turns = 0;
    let turnsStart = sample;
    const recent: [number, number][] = [];

    while (true) {
      pins = yield this.wait(conditions);
      sample = this.samplenum;
      const nextPhase = grayDecode(packBits(pins, channelCount));
      const oldPhase = phase;
      phase = nextPhase;
      if (phase !== oldPhase) {
        this.putValue(0, phaseStart, sample, String(oldPhase));
        phaseStart = sample;
      }

      const rawDelta = grayDelta(oldPhase, phase, steps);
      if (increment !== null && rawDelta !== increment) {
        this.putValue(1, incrementStart, sample, grayIncrementText(increment, steps));
        incrementStart = sample;
      } else if (increment === null) {
        incrementStart = sample;
      }
      increment = rawDelta;

      const oldCount = count;
      const delta = Math.abs(rawDelta) === steps >>> 1 ? 0 : rawDelta;
      count += delta;
      if (count !== oldCount) {
        this.putValue(2, countStart, sample, String(oldCount));
        countStart = sample;
      }

      const edgeCount = Math.trunc(this.options.edges);
      if (edgeCount) {
        const oldTurns = turns;
        turns = grayTurnCount(count, edgeCount);
        if (turns !== oldTurns) {
          this.putValue(3, turnsStart, sample, oldTurns >= 0 ? `+${oldTurns}` : String(oldTurns));
          turnsStart = sample;
        }
      }

      if (this.samplerate) {
        const period = Number(sample - previous) / this.samplerate;
        const frequency = Math.abs(rawDelta) / period;
        this.putValue(4, previous, sample, `${prefixFormat(period)}s, ${prefixFormat(frequency)}Hz`);

        const averagePeriod = Math.trunc(this.options.avg_period);
        if (averagePeriod) {
          recent.push([Math.abs(rawDelta), period]);
          if (recent.length > averagePeriod) recent.shift();
          const weight = recent.reduce((sum, [value]) => sum + value, 0);
          const average = recent.reduce((sum, [, value]) => sum + value, 0) / (weight || 1);
          this.putValue(5, previous, sample, `${prefixFormat(average)}s, ${prefixFormat(1 / average)}Hz`);
        }

        if (edgeCount) this.putValue(6, previous, sample, `${prefixFormat((60 * frequency) / edgeCount, 0)}rpm`);
      }

      previous = sample;
    }
  }
}

function packBits(pins: readonly number[], count: number): number {
  let value = 0;
  for (let index = 0; index < count; index++) value |= (pins[index]! & 1) << index;
  return value;
}

export default GraycodeDecoder;
