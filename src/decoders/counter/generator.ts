import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface CounterItem {
  readonly data?: 0 | 1;
  readonly reset?: 0 | 1;
  readonly hold?: number;
}

export interface CounterInitial {
  readonly data: 0 | 1;
  readonly reset?: 0 | 1;
}

export interface CounterCase extends RoundtripCase<CounterItem> {
  readonly initial: CounterInitial;
}

interface CounterAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

function integer(value: unknown): number {
  return Math.trunc(Number(value));
}

function selectedEdge(predicate: string, previous: number, current: number): boolean {
  if (predicate === 'rising') return previous === 0 && current === 1;
  if (predicate === 'falling') return previous === 1 && current === 0;
  return previous !== current;
}

function planCounter(
  config: CounterCase,
  items: readonly CounterItem[],
): { annotations: CounterAnnotation[]; bits: number; totalSamples: number } {
  const edgeOffset = integer(config.options.edge_off);
  const wordOffset = integer(config.options.word_off);
  const divider = Math.max(0, integer(config.options.divider));
  const deadCycles = Math.max(0, integer(config.options.dead_cycles));
  const haveReset = config.channels.reset !== undefined;
  let data = config.initial.data;
  let reset = config.initial.reset ?? 0;
  let sample = config.startSample + 2n;
  let edgeCount = edgeOffset;
  let wordCount = wordOffset;
  let edgeStart: bigint | null = null;
  let wordStart: bigint | null = null;
  let deadCount = String(config.options.start_with_reset) === 'yes' ? deadCycles : 0;
  let bits = 0;
  const annotations: CounterAnnotation[] = [];

  for (const item of items) {
    sample += BigInt(Math.max(0, Math.trunc(item.hold ?? 0)));
    const nextData = item.data ?? data;
    const nextReset = item.reset ?? reset;
    if (nextData === data && nextReset === reset) throw new Error('Counter item has no edge');

    const dataEvent = nextData !== data && selectedEdge(String(config.options.data_edge), data, nextData);
    const resetEvent =
      haveReset && nextReset !== reset && selectedEdge(String(config.options.reset_edge), reset, nextReset);
    data = nextData;
    reset = nextReset;

    if (resetEvent) {
      edgeCount = edgeOffset;
      edgeStart = sample;
      wordCount = wordOffset;
      wordStart = sample;
      annotations.push({
        ss: sample,
        es: sample,
        classIndex: 2,
        texts: ['Word reset', 'Reset', 'Rst', 'R'],
      });
      deadCount = deadCycles;
    } else if (dataEvent) {
      bits++;
      if (deadCount) {
        deadCount--;
        edgeStart = sample;
        wordStart = sample;
      } else {
        if (edgeStart === null) edgeStart = 0n;
        if (wordStart === null) wordStart = 0n;
        edgeCount++;
        annotations.push({ ss: edgeStart, es: sample, classIndex: 0, texts: [String(edgeCount)] });
        edgeStart = sample;
        const wordEdgeCount = edgeCount - edgeOffset;
        if (divider && wordEdgeCount % divider === 0) {
          wordCount++;
          annotations.push({ ss: wordStart, es: sample, classIndex: 1, texts: [String(wordCount)] });
          wordStart = sample;
        }
      }
    }
    sample += 1n;
  }
  return { annotations, bits, totalSamples: Number(sample - config.startSample) };
}

function summary(
  config: CounterCase,
  plan: { readonly annotations: readonly CounterAnnotation[]; readonly totalSamples: number },
): ExpectedFrame {
  const ss = plan.annotations.reduce((value, item) => (item.ss < value ? item.ss : value), config.startSample);
  return {
    protoId: 'counter',
    kind: 'summary',
    ss,
    es: config.startSample + BigInt(plan.totalSamples),
  };
}

function expectedAnnotations(annotations: readonly CounterAnnotation[]): ExpectedFrame[] {
  return annotations.map((item) => ({
    ss: item.ss,
    es: item.es,
    classIndex: item.classIndex,
    texts: item.texts,
  }));
}

function boundary(
  name: string,
  initial: CounterInitial,
  items: readonly CounterItem[],
  options: Record<string, string | number>,
  startSample: bigint,
): CounterCase {
  const config: CounterCase = {
    name,
    kind: 'boundary',
    seed: 0x434e5452,
    sampleRate: 1_000_000,
    startSample,
    initial,
    channels: { data: 2, reset: 5 },
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const plan = planCounter(config, items);
      yield {
        data: items,
        expected: [summary(config, plan)],
        expectedAnnotations: expectedAnnotations(plan.annotations),
        annotationCount: plan.annotations.length,
        payloadBits: Math.max(1, plan.bits),
      };
    },
  };
  return config;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x434e5452,
}: GenerationOptions = {}): Iterable<CounterCase> {
  yield boundary(
    'rising-offsets',
    { data: 0, reset: 0 },
    [{ data: 1 }, { data: 0 }, { data: 1, hold: 3 }, { data: 0 }, { data: 1 }, { data: 0 }],
    {
      data_edge: 'rising',
      divider: 0,
      reset_edge: 'falling',
      edge_off: 0,
      word_off: 0,
      dead_cycles: 0,
      start_with_reset: 'no',
    },
    19n,
  );
  yield boundary(
    'reset-divider-dead-cycles',
    { data: 0, reset: 0 },
    [
      { reset: 1 },
      { data: 1 },
      { data: 0 },
      { data: 1 },
      { data: 0 },
      { data: 1 },
      { data: 0 },
      { reset: 0 },
      { data: 1 },
      { data: 0 },
      { data: 1, reset: 1 },
      { data: 0 },
      { data: 1 },
    ],
    {
      data_edge: 'any',
      divider: 3,
      reset_edge: 'any',
      edge_off: 5,
      word_off: 9,
      dead_cycles: 2,
      start_with_reset: 'no',
    },
    9_007_199_254_740_990n,
  );
  yield boundary(
    'start-with-reset-falling-data',
    { data: 0, reset: 0 },
    [{ data: 1 }, { data: 0 }, { data: 1 }, { data: 0 }, { reset: 1 }, { data: 1 }, { data: 0 }, { data: 1 }],
    {
      data_edge: 'falling',
      divider: 2,
      reset_edge: 'rising',
      edge_off: 2,
      word_off: 4,
      dead_cycles: 1,
      start_with_reset: 'yes',
    },
    31n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = required;
  const perBlock = 8192;
  const random = randomWords(seed);
  const holds = new Uint8Array(count);
  let totalHolds = 0;
  for (let index = 0; index < count; index++) {
    const hold = random() % 23 === 0 ? 1 + (random() % 5) : 0;
    holds[index] = hold;
    totalHolds += hold;
  }
  const config: CounterCase = {
    name: 'seeded-long-toggle',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initial: { data: 0 },
    channels: { data: 1 },
    options: {
      data_edge: 'any',
      divider: 0,
      reset_edge: 'falling',
      edge_off: 0,
      word_off: 0,
      dead_cycles: 0,
      start_with_reset: 'no',
    },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let level: 0 | 1 = 0;
      let cursor = 2n;
      for (let offset = 0, block = 0; offset < count; offset += perBlock, block++) {
        const data: CounterItem[] = [];
        const end = Math.min(count, offset + perBlock);
        let firstExpected: ExpectedFrame | null = null;
        for (let index = offset; index < end; index++) {
          level = level ? 0 : 1;
          const hold = holds[index]!;
          const edge = cursor + BigInt(hold);
          data.push({ data: level, ...(hold ? { hold } : {}) });
          if (index === offset)
            firstExpected = {
              ss: offset === 0 ? 0n : edge - BigInt(hold) - 1n,
              es: edge,
              classIndex: 0,
              texts: [String(index + 1)],
            };
          cursor = edge + 1n;
        }
        yield {
          data,
          expected:
            block === 0
              ? [
                  {
                    protoId: 'counter',
                    kind: 'summary',
                    ss: config.startSample,
                    es: config.startSample + BigInt(2 + count + totalHolds),
                  },
                ]
              : [],
          expectedAnnotations: [firstExpected!],
          annotationCount: data.length,
          payloadBits: data.length,
        };
      }
    },
  };
  yield config;
}
