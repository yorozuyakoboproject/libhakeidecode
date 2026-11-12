import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface GuessBitrateItem {
  readonly level: 0 | 1;
  readonly hold: number;
}

export interface GuessBitrateCase extends RoundtripCase<GuessBitrateItem> {
  readonly initialLevel: 0 | 1;
  readonly initialSamples: number;
}

interface GuessBitrateAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

interface GuessBitratePlan {
  readonly blocks: readonly GuessBitrateAnnotation[][];
  readonly totalSamples: number;
}

function plan(config: GuessBitrateCase, items: readonly GuessBitrateItem[], blockSize: number): GuessBitratePlan {
  const blocks: GuessBitrateAnnotation[][] = [];
  let minimum: bigint | null = null;
  let edge = config.startSample + BigInt(config.initialSamples);
  let previousEdge = edge;
  let maximumEnd = edge;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (index) {
      const width = edge - previousEdge;
      if (minimum === null || width < minimum) {
        minimum = width;
        const bitrate = Math.trunc(config.sampleRate / Number(width));
        const block = Math.floor(index / blockSize);
        (blocks[block] ??= []).push({
          ss: previousEdge,
          es: edge,
          classIndex: 0,
          texts: [String(bitrate)],
        });
      }
    }
    previousEdge = edge;
    edge += BigInt(item.hold);
    maximumEnd = edge;
  }
  return { blocks, totalSamples: Number(maximumEnd - config.startSample) };
}

function expectedAnnotations(annotations: readonly GuessBitrateAnnotation[], limit = Infinity): ExpectedFrame[] {
  return annotations.slice(0, limit).map((annotation) => ({ ...annotation }));
}

function summary(config: GuessBitrateCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'guess_bitrate',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function boundary(
  name: string,
  initialLevel: 0 | 1,
  holds: readonly number[],
  sampleRate: number,
  startSample: bigint,
): GuessBitrateCase {
  const config: GuessBitrateCase = {
    name,
    kind: 'boundary',
    seed: 0x42495452,
    sampleRate,
    startSample,
    initialLevel,
    initialSamples: 2,
    channels: { data: 0 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      let level = initialLevel;
      const items = holds.map((hold) => {
        level = level ? 0 : 1;
        return { level, hold };
      });
      const result = plan(this, items, items.length || 1);
      yield {
        data: items,
        expected: [summary(this, result.totalSamples)],
        expectedAnnotations: expectedAnnotations(result.blocks[0] ?? []),
        annotationCount: result.blocks[0]?.length ?? 0,
        payloadBits: this.initialSamples + holds.reduce((sum, hold) => sum + hold, 0),
      };
    },
  };
  return config;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x42495452,
}: GenerationOptions = {}): Iterable<GuessBitrateCase> {
  yield boundary('decreasing-intervals', 0, [13, 7, 19, 7, 7, 11, 5], 1_000_000, 17n);
  yield boundary('constant-interval', 1, [20, 20, 20, 20, 20, 20], 2_000_000, 9_007_199_254_740_990n);
  yield boundary('one-sample-floor', 0, [9, 3, 2, 5, 1, 8], 800_000, 31n);

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 1024;
  const count = 4096;
  const random = randomWords(seed);
  let level: 0 | 1 = 0;
  const blockMinimum = [256, 220, 180, 140] as const;
  const items: GuessBitrateItem[] = [];
  for (let index = 0; index < count; index++) {
    level = level ? 0 : 1;
    const hold = index % perBlock === 0 ? blockMinimum[index / perBlock]! : 260 + (random() & 31);
    items.push({ level, hold });
  }
  const config: GuessBitrateCase = {
    name: 'seeded-long-edge-stream',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialLevel: 0,
    initialSamples: 2,
    channels: { data: 3 },
    options: {},
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
          expectedAnnotations: expectedAnnotations(result.blocks[block] ?? [], 4),
          annotationCount: result.blocks[block]?.length ?? 0,
          payloadBits: samples,
        };
      }
    },
  };
  yield config;
}
