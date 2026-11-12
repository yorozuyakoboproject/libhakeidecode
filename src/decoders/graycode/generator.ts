import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { grayDecode, grayDelta, grayEncode, grayIncrementText, grayTurnCount, prefixFormat } from './index.js';

export interface GraycodeItem {
  readonly state: number;
  readonly hold: number;
}

export interface GraycodeCase extends RoundtripCase<GraycodeItem> {
  readonly initial: number;
  readonly initialSamples: number;
}

interface GraycodeAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

interface GraycodePlan {
  readonly blocks: readonly GraycodeAnnotation[][];
  readonly totalSamples: number;
}

function plan(config: GraycodeCase, items: readonly GraycodeItem[], blockSize: number): GraycodePlan {
  const channelCount = Object.keys(config.channels).length;
  const steps = 1 << channelCount;
  const edgeCount = Math.trunc(Number(config.options.edges));
  const averagePeriod = Math.trunc(Number(config.options.avg_period));
  const blocks: GraycodeAnnotation[][] = [];
  const recent: [number, number][] = [];
  let phase = grayDecode(config.initial);
  let phaseStart = config.startSample;
  let increment: number | null = null;
  let incrementStart = config.startSample;
  let count = 0;
  let countStart = config.startSample;
  let turns = 0;
  let turnsStart = config.startSample;
  let previous = config.startSample;
  let sample = config.startSample + BigInt(config.initialSamples);

  const emit = (itemIndex: number, annotation: GraycodeAnnotation): void => {
    const block = Math.floor(itemIndex / blockSize);
    (blocks[block] ??= []).push(annotation);
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const oldPhase = phase;
    phase = grayDecode(item.state);
    if (phase !== oldPhase) {
      emit(index, { ss: phaseStart, es: sample, classIndex: 0, texts: [String(oldPhase)] });
      phaseStart = sample;
    }

    const rawDelta = grayDelta(oldPhase, phase, steps);
    if (increment !== null && rawDelta !== increment) {
      emit(index, {
        ss: incrementStart,
        es: sample,
        classIndex: 1,
        texts: [grayIncrementText(increment, steps)],
      });
      incrementStart = sample;
    } else if (increment === null) {
      incrementStart = sample;
    }
    increment = rawDelta;

    const oldCount = count;
    count += Math.abs(rawDelta) === steps >>> 1 ? 0 : rawDelta;
    if (count !== oldCount) {
      emit(index, { ss: countStart, es: sample, classIndex: 2, texts: [String(oldCount)] });
      countStart = sample;
    }

    if (edgeCount) {
      const oldTurns = turns;
      turns = grayTurnCount(count, edgeCount);
      if (turns !== oldTurns) {
        emit(index, {
          ss: turnsStart,
          es: sample,
          classIndex: 3,
          texts: [oldTurns >= 0 ? `+${oldTurns}` : String(oldTurns)],
        });
        turnsStart = sample;
      }
    }

    const period = Number(sample - previous) / config.sampleRate;
    const frequency = Math.abs(rawDelta) / period;
    emit(index, {
      ss: previous,
      es: sample,
      classIndex: 4,
      texts: [`${prefixFormat(period)}s, ${prefixFormat(frequency)}Hz`],
    });

    if (averagePeriod) {
      recent.push([Math.abs(rawDelta), period]);
      if (recent.length > averagePeriod) recent.shift();
      const weight = recent.reduce((sum, [value]) => sum + value, 0);
      const average = recent.reduce((sum, [, value]) => sum + value, 0) / (weight || 1);
      emit(index, {
        ss: previous,
        es: sample,
        classIndex: 5,
        texts: [`${prefixFormat(average)}s, ${prefixFormat(1 / average)}Hz`],
      });
    }
    if (edgeCount)
      emit(index, {
        ss: previous,
        es: sample,
        classIndex: 6,
        texts: [`${prefixFormat((60 * frequency) / edgeCount, 0)}rpm`],
      });

    previous = sample;
    sample += BigInt(item.hold);
  }

  return { blocks, totalSamples: Number(sample - config.startSample) };
}

function expectedAnnotations(annotations: readonly GraycodeAnnotation[], limit = Infinity): ExpectedFrame[] {
  return annotations.slice(0, limit).map((annotation) => ({ ...annotation }));
}

function summary(config: GraycodeCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'graycode',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function makeCase(
  name: string,
  initial: number,
  states: readonly number[],
  holds: readonly number[],
  options: Record<string, string | number>,
  sampleRate: number,
  startSample: bigint,
): GraycodeCase {
  const initialSamples = 2;
  return {
    name,
    kind: 'boundary',
    seed: 0x47524159,
    sampleRate,
    startSample,
    initial,
    initialSamples,
    channels: {},
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const items = states.map((state, index) => ({ state, hold: holds[index % holds.length]! }));
      const planResult = plan(this, items, items.length || 1);
      const channelCount = Object.keys(this.channels).length;
      const bits = (initialSamples + items.reduce((sum, item) => sum + item.hold, 0)) * channelCount;
      yield {
        data: items,
        expected: [summary(this, planResult.totalSamples)],
        expectedAnnotations: expectedAnnotations(planResult.blocks[0] ?? []),
        annotationCount: planResult.blocks[0]?.length ?? 0,
        payloadBits: bits,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x47524159,
}: GenerationOptions = {}): Iterable<GraycodeCase> {
  yield withChannels(
    makeCase(
      'two-bit-direction-reversal',
      grayEncode(0),
      [1, 3, 1, 2, 0, 2, 3, 1].map(grayEncode),
      [4, 4, 3, 5, 4, 3, 4, 4, 3],
      { edges: 4, avg_period: 3 },
      1_000_000,
      17n,
    ),
    ['d0', 'd1'],
  );
  yield withChannels(
    makeCase(
      'single-bit-half-step',
      grayEncode(0),
      [1, 0, 1, 0, 1, 0, 1].map(grayEncode),
      [6, 5, 4, 6, 5, 4, 6],
      { edges: 0, avg_period: 0 },
      2_000_000,
      9_007_199_254_740_990n,
    ),
    ['d0'],
  );
  yield withChannels(
    makeCase(
      'eight-bit-wrap',
      grayEncode(254),
      [255, 0, 1, 2, 3, 2, 1, 0, 255, 254].map(grayEncode),
      [3, 4, 3, 4, 3, 4, 3, 4, 3, 4],
      { edges: 16, avg_period: 1 },
      4_000_000,
      31n,
    ),
    Array.from({ length: 8 }, (_, index) => `d${index}`),
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 2048;
  const count = 8192;
  const random = randomWords(seed);
  let phase = 0;
  let previousState = grayEncode(phase);
  const items: GraycodeItem[] = [];
  for (let index = 0; index < count; index++) {
    if (phase === 0) phase = 1;
    else if (phase === 255) phase = 254;
    else phase += random() & 1 ? 1 : -1;
    const state = grayEncode(phase);
    if (state === previousState) throw new Error('Graycode generator produced a duplicate state');
    previousState = state;
    items.push({ state, hold: 14 + (random() % 5) });
  }
  const config: GraycodeCase = {
    name: 'seeded-long-encoder-walk',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initial: grayEncode(0),
    initialSamples: 2,
    channels: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`d${index}`, index])),
    options: { edges: 32, avg_period: 7 },
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
          expectedAnnotations: expectedAnnotations(result.blocks[block] ?? [], 8),
          annotationCount: result.blocks[block]?.length ?? 0,
          payloadBits: samples * 8,
        };
      }
    },
  };
  yield config;
}

function withChannels(config: GraycodeCase, ids: readonly string[]): GraycodeCase {
  return {
    ...config,
    channels: Object.fromEntries(ids.map((id, index) => [id, index])),
  };
}
