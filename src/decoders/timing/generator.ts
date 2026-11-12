import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { normalizeTime, terseTimes } from './index.js';

export interface TimingItem {
  readonly hold: number;
}

export interface TimingCase extends RoundtripCase<TimingItem> {
  readonly initialLevel: 0 | 1;
  readonly initialSamples: number;
}

interface TimingAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

interface TimingPlan {
  readonly blocks: readonly TimingAnnotation[][];
  readonly totalSamples: number;
}

function plan(config: TimingCase, items: readonly TimingItem[], blockSize: number): TimingPlan {
  const blocks: TimingAnnotation[][] = [];
  const recent: number[] = [];
  const averagePeriod = Number(config.options.avg_period);
  const showDelta = config.options.delta === 'yes';
  const format = String(config.options.format);
  const edge = String(config.options.edge);
  let sample = config.startSample + BigInt(config.initialSamples);
  let previousLevel = config.initialLevel;
  let start: bigint | null = null;
  let lastTime: number | null = null;

  const emit = (event: number, annotation: TimingAnnotation): void => {
    const block = Math.floor(event / blockSize);
    (blocks[block] ??= []).push(annotation);
  };

  for (let index = 0; index < items.length; index++) {
    const level = previousLevel ? 0 : 1;
    const selected =
      edge === 'any' ||
      (edge === 'rising' && !previousLevel && level === 1) ||
      (edge === 'falling' && previousLevel && level === 0);
    previousLevel = level;
    if (selected && start === null) {
      start = sample;
    } else if (selected) {
      const samples = Number(sample - start!);
      const time = samples / config.sampleRate;
      if (format === 'full') emit(index, { ss: start!, es: sample, classIndex: 0, texts: [normalizeTime(time)] });
      else if (format === 'samples')
        emit(index, { ss: start!, es: sample, classIndex: 1, texts: terseTimes(samples, format) });
      else emit(index, { ss: start!, es: sample, classIndex: 1, texts: terseTimes(time, format) });

      if (averagePeriod > 0) {
        if (time > 0) recent.push(time);
        if (recent.length > averagePeriod) recent.shift();
        const average = recent.reduce((sum, value) => sum + value, 0) / recent.length;
        emit(index, { ss: start!, es: sample, classIndex: 2, texts: [normalizeTime(average)] });
      }
      if (lastTime && showDelta)
        emit(index, { ss: start!, es: sample, classIndex: 3, texts: [normalizeTime(time - lastTime)] });
      lastTime = time;
      start = sample;
    }
    sample += BigInt(items[index]!.hold);
  }

  return { blocks, totalSamples: Number(sample - config.startSample) };
}

function annotations(block: readonly TimingAnnotation[] | undefined, limit = Infinity): ExpectedFrame[] {
  return (block ?? []).slice(0, limit).map((annotation) => ({ ...annotation }));
}

function summary(config: TimingCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'timing',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function boundary(
  name: string,
  initialLevel: 0 | 1,
  holds: readonly number[],
  options: Record<string, string | number>,
  sampleRate: number,
  startSample: bigint,
): TimingCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x54494d45,
    sampleRate,
    startSample,
    initialLevel,
    initialSamples: 2,
    channels: { data: 0 },
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = holds.map((hold) => ({ hold }));
      const result = plan(this, data, data.length);
      yield {
        data,
        expected: [summary(this, result.totalSamples)],
        expectedAnnotations: annotations(result.blocks[0]),
        annotationCount: result.blocks[0]?.length ?? 0,
        payloadBits: this.initialSamples + holds.reduce((sum, hold) => sum + hold, 0),
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x54494d45,
}: GenerationOptions = {}): Iterable<TimingCase> {
  yield boundary(
    'full-average-delta',
    0,
    [7, 13, 7, 9, 11, 4],
    { avg_period: 3, edge: 'any', delta: 'yes', format: 'full' },
    1_000_000,
    17n,
  );
  yield boundary(
    'rising-samples',
    0,
    [1000, 1250, 1000, 750, 1500],
    { avg_period: 1, edge: 'rising', delta: 'no', format: 'samples' },
    2_000_000,
    9_007_199_254_740_990n,
  );
  yield boundary(
    'falling-terse-auto',
    1,
    [3, 5, 8, 13, 21, 34],
    { avg_period: 0, edge: 'falling', delta: 'yes', format: 'terse-auto' },
    4_000_000,
    31n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 1024;
  const count = 4096;
  const random = randomWords(seed);
  const items = Array.from({ length: count }, () => ({ hold: 256 + (random() & 31) }));
  const config: TimingCase = {
    name: 'seeded-long-intervals',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialLevel: 0,
    initialSamples: 2,
    channels: { data: 4 },
    options: { avg_period: 8, edge: 'any', delta: 'yes', format: 'terse-auto' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const result = plan(this, items, perBlock);
      for (let offset = 0; offset < items.length; offset += perBlock) {
        const block = Math.floor(offset / perBlock);
        const data = items.slice(offset, offset + perBlock);
        const samples = data.reduce((sum, item) => sum + item.hold, 0) + (offset === 0 ? this.initialSamples : 0);
        yield {
          data,
          expected: block === 0 ? [summary(this, result.totalSamples)] : [],
          expectedAnnotations: annotations(result.blocks[block], 6),
          annotationCount: result.blocks[block]?.length ?? 0,
          payloadBits: samples,
        };
      }
    },
  };
  yield config;
}
