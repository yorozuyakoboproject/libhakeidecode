import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { markerIntervals, markerSamples, tailSamples } from './encoder.js';

export interface MillerRun {
  readonly bits: readonly number[];
  readonly malformed?: boolean;
}

export interface MillerCase extends RoundtripCase<MillerRun> {}

interface SamplePoint {
  readonly sample: bigint;
  readonly fraction: number;
}

function point(sample: bigint, fraction = 0): SamplePoint {
  const whole = Math.trunc(fraction);
  return { sample: sample + BigInt(whole), fraction: fraction - whole };
}

function offset(value: SamplePoint, delta: number): SamplePoint {
  return point(value.sample, value.fraction + delta);
}

function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  const difference = value - lower;
  if (difference < 0.5) return lower;
  if (difference > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

export function simulateMiller(
  run: MillerRun,
  unitSamples: number,
  firstEdge: bigint,
): { annotations: ExpectedFrame[]; count: number } {
  const intervals = markerIntervals(run.bits);
  if (run.malformed) intervals.push(0.5);
  const markers = markerSamples(intervals, unitSamples).map((value) => firstEdge + BigInt(value));
  const annotations: ExpectedFrame[] = [];
  const emitted: number[] = [];
  let error = false;

  const addBit = (value: number, ss: SamplePoint, es: SamplePoint): void => {
    emitted.push(value);
    annotations.push({
      classIndex: 0,
      texts: [String(value)],
      ss: ss.sample,
      es: es.sample,
    });
  };

  let previousBit = 0;
  let expectedStart = offset(point(markers[0]!), unitSamples);
  addBit(0, point(markers[0]!), expectedStart);

  for (let index = 1; index < markers.length; index++) {
    const marker = markers[index]!;
    const previous = markers[index - 1]!;
    const timedelta = roundHalfEven(Number(marker - previous) / unitSamples / 0.5) * 0.5;
    if (previousBit === 0) {
      if (timedelta === 1) {
        addBit(0, point(marker), offset(point(marker), unitSamples));
        expectedStart = offset(point(marker), unitSamples);
      } else if (timedelta === 1.5) {
        addBit(1, expectedStart, offset(point(marker), 0.5 * unitSamples));
        expectedStart = offset(point(marker), 0.5 * unitSamples);
        previousBit = 1;
      } else if (timedelta >= 2) {
        break;
      } else {
        annotations.push({
          classIndex: 1,
          texts: ['ERROR'],
          ss: previous,
          es: marker,
        });
        error = true;
        break;
      }
    } else {
      if (timedelta <= 0.5) {
        annotations.push({
          classIndex: 1,
          texts: ['ERROR'],
          ss: previous,
          es: marker,
        });
        error = true;
        break;
      }
      if (timedelta === 1) {
        addBit(1, expectedStart, offset(point(marker), 0.5 * unitSamples));
        expectedStart = offset(point(marker), 0.5 * unitSamples);
      } else if (timedelta === 1.5) {
        addBit(0, expectedStart, point(marker));
        addBit(0, point(marker), offset(point(marker), unitSamples));
        expectedStart = offset(point(marker), unitSamples);
        previousBit = 0;
      } else if (timedelta === 2) {
        addBit(0, expectedStart, offset(expectedStart, unitSamples));
        addBit(1, offset(point(marker), -0.5 * unitSamples), offset(point(marker), 0.5 * unitSamples));
        expectedStart = offset(point(marker), 0.5 * unitSamples);
      } else {
        addBit(0, expectedStart, offset(expectedStart, unitSamples));
        break;
      }
    }
  }

  if (!error && previousBit === 1) addBit(0, expectedStart, offset(expectedStart, unitSamples));
  if (!error) {
    const start = annotations[0]!.ss as bigint;
    const end = annotations[annotations.length - 1]!.es as bigint;
    let text = '';
    for (let index = 0; index < emitted.length; index++) {
      text += String(emitted[index]);
      if ((index + 1) % 4 === 0) text += ' ';
    }
    annotations.push({ classIndex: 1, texts: [text], ss: start, es: end });
  }
  return { annotations, count: annotations.length };
}

function randomValidBits(random: () => number, minimum: number): number[] {
  const bits: number[] = [];
  let state = 0;
  while (bits.length < minimum) {
    if (state === 0) {
      const bit = random() & 1;
      bits.push(bit);
      state = bit;
    } else if ((random() & 3) !== 0) {
      bits.push(1);
    } else {
      const second = random() & 1;
      bits.push(0, second);
      if (second === 0) state = 0;
    }
  }
  if (state !== 0) bits.push(0, 0);
  return bits;
}

function formatOptions(edge: 'rising' | 'falling' | 'either', sampleRate: number): Record<string, number | string> {
  return { baudrate: sampleRate / (edge === 'either' ? 2 : 4), edge };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d494c4c,
}: GenerationOptions = {}): Iterable<MillerCase> {
  const boundaries: readonly {
    name: string;
    edge: 'rising' | 'falling' | 'either';
    bits: readonly number[];
    malformed?: boolean;
  }[] = [
    { name: 'falling-full-turn', edge: 'falling', bits: [1, 0, 0] },
    { name: 'rising-alternating', edge: 'rising', bits: [0, 1, 0, 1, 0, 0] },
    { name: 'either-empty', edge: 'either', bits: [] },
    { name: 'falling-error', edge: 'falling', bits: [0, 1, 0, 0], malformed: true },
  ];

  for (const item of boundaries) {
    const sampleRate = 4_000_000;
    const options = formatOptions(item.edge, sampleRate);
    const unitSamples = sampleRate / Number(options.baudrate);
    const startSample = item.name === 'falling-error' ? 9_007_199_254_740_990n : 3n;
    const firstEdge = startSample + 1n;
    const run: MillerRun = item.malformed ? { bits: item.bits, malformed: true } : { bits: item.bits };
    const expected = simulateMiller(run, unitSamples, firstEdge);
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate,
      startSample,
      channels: { data: 2 },
      options,
      chunkSamples: [1, 2, 3, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        yield {
          data: [run],
          expected: [{ protoId: 'miller', kind: 'summary' }],
          expectedAnnotations: expected.annotations,
          annotationCount: expected.count,
          payloadBits: item.bits.length + 1,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const sampleRate = 1_000_000;
  const edge = 'falling' as const;
  const options = formatOptions(edge, sampleRate);
  const unitSamples = sampleRate / Number(options.baudrate);
  const perBlock = 65_536;
  const blockCount = Math.max(2, Math.ceil(required / perBlock));
  yield {
    name: 'seeded-long-falling',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { data: 0 },
    options,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = 0n;
      for (let block = 0; block < blockCount; block++) {
        const bits = randomValidBits(random, perBlock);
        const firstEdge = block === 0 ? cursor + 1n : cursor;
        const run: MillerRun = { bits };
        const expected = simulateMiller(run, unitSamples, firstEdge);
        const markers = markerSamples(markerIntervals(bits), unitSamples);
        const lastMarker = firstEdge + BigInt(markers[markers.length - 1]!);
        cursor = lastMarker + BigInt(tailSamples(edge, unitSamples));
        yield {
          data: [run],
          expected: block === 0 ? [{ protoId: 'miller', kind: 'summary' }] : [],
          expectedAnnotations: expected.annotations.slice(0, 1),
          annotationCount: expected.count,
          payloadBits: bits.length + 1,
        };
      }
    },
  };
}
