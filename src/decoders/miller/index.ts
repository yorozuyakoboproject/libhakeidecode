import { Decoder, EOFError, OUTPUT_ANN, OUTPUT_BINARY, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitPredicate } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface MillerOptions {
  baudrate: number;
  edge: 'rising' | 'falling' | 'either';
}

interface SamplePoint {
  readonly sample: bigint;
  readonly fraction: number;
}

interface PendingAnnotation {
  readonly classIndex: number;
  readonly texts: readonly string[];
  readonly ss: bigint;
  readonly es: bigint;
}

function point(sample: bigint, fraction = 0): SamplePoint {
  const whole = Math.trunc(fraction);
  return { sample: sample + BigInt(whole), fraction: fraction - whole };
}

function offset(value: SamplePoint, delta: number): SamplePoint {
  return point(value.sample, value.fraction + delta);
}

function sample(value: SamplePoint): bigint {
  return value.sample;
}

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  const difference = value - lower;
  if (difference < 0.5) return lower;
  if (difference > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

function roundTo(value: number, unit: number): number {
  return roundHalfEven(value / unit) * unit;
}

export class MillerDecoder extends Decoder<MillerOptions> {
  static descriptor = descriptor;

  samplerate: number | null = null;
  private outAnn = -1;
  private outBinary = -1;

  constructor(options: Partial<MillerOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    const baudrate = Number(this.options.baudrate);
    if (!(baudrate > 0) || !Number.isFinite(baudrate)) throw new RangeError('Baud rate must be positive.');
    const timeunit = this.samplerate / baudrate;
    if (!(timeunit > 0) || !Number.isFinite(timeunit)) throw new RangeError('Invalid Miller time unit.');
    const edge = this.options.edge;
    if (edge !== 'rising' && edge !== 'falling' && edge !== 'either')
      throw new RangeError('Miller edge must be rising, falling, or either.');
    const predicate = edge[0] as WaitPredicate;
    const timeout = Math.trunc(3 * timeunit);
    const pending: PendingAnnotation[] = [];

    const flush = (end: bigint): void => {
      while (pending.length && pending[0]!.es <= end) {
        const item = pending.shift()!;
        this.put(item.ss, item.es, this.outAnn, [item.classIndex, item.texts]);
      }
    };

    try {
      while (true) {
        yield this.wait({ 0: predicate });
        flush(this.samplenum);
        let previousEdge = this.samplenum;
        let expectedStart = offset(point(previousEdge), timeunit);
        let previousBit = 0;
        let bitCount = 0;
        let stringStart: bigint | null = null;
        let stringEnd: bigint | null = null;
        let failed = false;
        const bytes: number[] = [];
        const text: string[] = [];

        const record = (value: number, ss: SamplePoint, es: SamplePoint): void => {
          const start = sample(ss);
          const end = sample(es);
          pending.push({ classIndex: 0, texts: [String(value)], ss: start, es: end });
          if (stringStart === null) stringStart = start;
          stringEnd = end;
          const byte = bitCount >> 3;
          bytes[byte] = (bytes[byte] ?? 0) | (value << (bitCount & 7));
          bitCount++;
          text.push(String(value));
          if (bitCount % 4 === 0) text.push(' ');
        };

        record(0, point(previousEdge), expectedStart);

        while (true) {
          yield this.wait([{ 0: predicate }, { skip: timeout }]);
          const now = this.samplenum;
          flush(now);
          const sampledelta = Number(now - previousEdge);
          previousEdge = now;
          const timedelta = roundTo(sampledelta / timeunit, 0.5);

          if (previousBit === 0) {
            if (timedelta === 1) {
              record(0, point(now), offset(point(now), timeunit));
              expectedStart = offset(point(now), timeunit);
            } else if (timedelta === 1.5) {
              record(1, expectedStart, offset(point(now), 0.5 * timeunit));
              expectedStart = offset(point(now), 0.5 * timeunit);
              previousBit = 1;
            } else if (timedelta >= 2) {
              break;
            } else {
              pending.push({ classIndex: 1, texts: ['ERROR'], ss: now - BigInt(sampledelta), es: now });
              failed = true;
              break;
            }
          } else {
            if (timedelta <= 0.5) {
              pending.push({ classIndex: 1, texts: ['ERROR'], ss: now - BigInt(sampledelta), es: now });
              failed = true;
              break;
            }
            if (timedelta === 1) {
              record(1, expectedStart, offset(point(now), 0.5 * timeunit));
              expectedStart = offset(point(now), 0.5 * timeunit);
            } else if (timedelta === 1.5) {
              record(0, expectedStart, point(now));
              record(0, point(now), offset(point(now), timeunit));
              expectedStart = offset(point(now), timeunit);
              previousBit = 0;
            } else if (timedelta === 2) {
              record(0, expectedStart, offset(expectedStart, timeunit));
              record(1, offset(point(now), -0.5 * timeunit), offset(point(now), 0.5 * timeunit));
              expectedStart = offset(point(now), 0.5 * timeunit);
            } else {
              record(0, expectedStart, offset(expectedStart, timeunit));
              break;
            }
          }
        }

        flush(this.samplenum);
        if (failed || bitCount === 0 || stringStart === null || stringEnd === null) continue;
        this.put(stringStart, stringEnd, this.outAnn, [1, [text.join('')]]);
        this.put(stringStart, stringEnd, this.outBinary, [0, Uint8Array.from(bytes)]);
      }
    } catch (error) {
      if (!(error instanceof EOFError)) throw error;
      flush(this.samplenum);
    }
  }
}

export default MillerDecoder;
