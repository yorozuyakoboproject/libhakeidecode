import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { parallelItemBytes } from './index.js';

export interface ParallelItem {
  readonly data: number;
  readonly hold: number;
  readonly clk: 0 | 1;
  readonly rst: 0 | 1;
}

export interface ParallelCase extends RoundtripCase<ParallelItem> {
  readonly initialData: number;
  readonly initialClk: 0 | 1;
  readonly initialRst: 0 | 1;
  readonly initialSamples: number;
}

interface ParallelAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

interface ParallelBlock {
  readonly annotations: ParallelAnnotation[];
  readonly frames: ExpectedFrame[];
}

interface ParallelPlan {
  readonly blocks: readonly ParallelBlock[];
  readonly totalSamples: number;
}

interface PendingItem {
  readonly ss: bigint;
  readonly data: number;
}

interface PendingWord {
  readonly ss: bigint;
  es?: bigint;
  readonly data: number;
}

function selectedEdge(edge: string, previous: number, current: number): boolean {
  if (edge === 'rising') return !previous && !!current;
  if (edge === 'falling') return !!previous && !current;
  return previous !== current;
}

function itemText(value: number, bits: number): string {
  return value.toString(16).padStart(Math.ceil(bits / 4), '0');
}

function wireInteger(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function plan(config: ParallelCase, items: readonly ParallelItem[], blockSize: number): ParallelPlan {
  const blocks: ParallelBlock[] = [];
  const channelIds = Object.keys(config.channels);
  const dataBits = channelIds
    .filter((id) => /^d\d+$/.test(id))
    .map((id) => Number(id.slice(1)))
    .sort((left, right) => left - right);
  const busWidth = dataBits[dataBits.length - 1]! + 1;
  const dataSet = new Set(dataBits);
  const haveClock = config.channels.clk !== undefined;
  const haveReset = config.channels.rst !== undefined;
  const wordsize = Math.trunc(Number(config.options.wordsize));
  const resetActive = config.options.reset_polarity === 'high-active' ? 1 : 0;
  let pending: PendingItem | null = null;
  let words: PendingWord[] = [];
  let inReset = false;
  let sample = config.startSample + BigInt(config.initialSamples);
  let previousData = config.initialData;
  let previousClk = config.initialClk;
  let previousRst = config.initialRst;

  const annotation = (event: number, value: ParallelAnnotation): void => {
    const block = Math.floor(event / blockSize);
    (blocks[block] ??= { annotations: [], frames: [] }).annotations.push(value);
  };
  const frame = (event: number, value: ExpectedFrame): void => {
    const block = Math.floor(event / blockSize);
    (blocks[block] ??= { annotations: [], frames: [] }).frames.push(value);
  };
  const flushWord = (event: number): void => {
    if (!words.length) return;
    const values = words.map((word) => word.data);
    if (config.options.endianness === 'big') values.reverse();
    let word = 0n;
    for (let index = 0; index < values.length; index++) word |= BigInt(values[index]!) << BigInt(index * busWidth);
    const ss = words[0]!.ss;
    const es = words[words.length - 1]!.es!;
    const digits = Math.ceil((busWidth * wordsize) / 4);
    annotation(event, { ss, es, classIndex: 1, texts: [word.toString(16).padStart(digits, '0')] });
    frame(event, {
      ss,
      es,
      protoId: 'parallel',
      kind: 'protocol',
      data: ['WORD', [wireInteger(word), busWidth, wordsize]],
    });
    if (values.length !== wordsize)
      annotation(event, { ss, es, classIndex: 2, texts: ['incomplete word size', 'word size', 'ws'] });
    words = [];
  };
  const queueWord = (event: number, now: bigint, item: number | null): void => {
    if (!wordsize) return;
    if (words.length) {
      words[words.length - 1]!.es = now;
      if (words.length === wordsize) flushWord(event);
    }
    if (item !== null) words.push({ ss: now, data: item });
  };
  const handleBits = (event: number, now: bigint, item: number | null): void => {
    if (pending) {
      const { ss, data } = pending;
      pending = null;
      annotation(event, { ss, es: now, classIndex: 0, texts: [itemText(data, busWidth)] });
      frame(event, { ss, es: now, protoId: 'parallel', kind: 'protocol', data: ['ITEM', [data, busWidth]] });
    }
    if (item !== null) pending = { ss: now, data: item };
    queueWord(event, now, item);
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const clockEdge = haveClock && selectedEdge(String(config.options.clock_edge), previousClk, item.clk);
    const dataEdge = [...dataSet].some((bit) => ((previousData >>> bit) & 1) !== ((item.data >>> bit) & 1));
    const resetEdge = haveReset && item.rst !== previousRst;
    if (resetEdge) {
      inReset = item.rst === resetActive;
      if (inReset) {
        handleBits(index, sample, null);
        flushWord(index);
      }
    }
    if (!inReset && (clockEdge || (!haveClock && dataEdge))) handleBits(index, sample, item.data);
    previousData = item.data;
    previousClk = item.clk;
    previousRst = item.rst;
    sample += BigInt(item.hold);
  }

  const endEvent = Math.max(0, items.length - 1);
  handleBits(endEvent, sample, null);
  return { blocks, totalSamples: Number(sample - config.startSample) };
}

function blockAt(result: ParallelPlan, index: number): ParallelBlock {
  return result.blocks[index] ?? { annotations: [], frames: [] };
}

function annotations(block: ParallelBlock | undefined, limit = Infinity): ExpectedFrame[] {
  return (block?.annotations ?? []).slice(0, limit).map((annotation) => ({ ...annotation }));
}

function boundary(
  name: string,
  initialData: number,
  initialClk: 0 | 1,
  initialRst: 0 | 1,
  items: readonly ParallelItem[],
  options: Record<string, OptionValue>,
  channels: Record<string, number>,
  sampleRate: number,
  startSample: bigint,
  checkBinaryWidth?: () => void,
): ParallelCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x50415241,
    sampleRate,
    startSample,
    initialData,
    initialClk,
    initialRst,
    initialSamples: 2,
    channels,
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      checkBinaryWidth?.();
      const result = plan(this, items, items.length);
      const block = blockAt(result, 0);
      const dataBits = Object.keys(channels).filter((id) => /^d\d+$/.test(id)).length;
      yield {
        data: items,
        expected: block.frames,
        expectedAnnotations: annotations(block),
        annotationCount: block.annotations.length,
        payloadBits: (this.initialSamples + items.reduce((sum, item) => sum + item.hold, 0)) * Math.max(1, dataBits),
      };
    },
  };
}

function wordOptions(edge: string, wordsize: number, endianness: string): Record<string, OptionValue> {
  return { clock_edge: edge, reset_polarity: 'low-active', wordsize, endianness };
}

function dataChannels(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`d${index}`, index]));
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x50415241,
}: GenerationOptions = {}): Iterable<ParallelCase> {
  yield boundary(
    'clocked-items',
    0,
    0,
    1,
    [
      { data: 1, clk: 1, rst: 1, hold: 4 },
      { data: 2, clk: 1, rst: 1, hold: 4 },
      { data: 2, clk: 0, rst: 1, hold: 4 },
      { data: 2, clk: 1, rst: 1, hold: 4 },
      { data: 3, clk: 1, rst: 1, hold: 3 },
      { data: 3, clk: 0, rst: 1, hold: 3 },
      { data: 3, clk: 1, rst: 1, hold: 5 },
    ],
    wordOptions('rising', 0, 'little'),
    { ...dataChannels(4), clk: 4 },
    1_000_000,
    17n,
  );
  yield boundary(
    'little-endian-words',
    0,
    0,
    1,
    [
      { data: 1, clk: 1, rst: 1, hold: 4 },
      { data: 2, clk: 0, rst: 1, hold: 4 },
      { data: 3, clk: 1, rst: 1, hold: 4 },
      { data: 4, clk: 0, rst: 1, hold: 4 },
      { data: 5, clk: 1, rst: 1, hold: 4 },
    ],
    wordOptions('either', 2, 'little'),
    { ...dataChannels(4), clk: 4 },
    2_000_000,
    31n,
  );
  yield boundary(
    'big-endian-partial-word',
    0,
    0,
    1,
    [
      { data: 0x12, clk: 1, rst: 1, hold: 3 },
      { data: 0x34, clk: 0, rst: 1, hold: 3 },
      { data: 0x56, clk: 1, rst: 1, hold: 3 },
      { data: 0x78, clk: 0, rst: 1, hold: 3 },
    ],
    wordOptions('either', 3, 'big'),
    { ...dataChannels(8), clk: 8 },
    4_000_000,
    53n,
  );
  yield boundary(
    'reset-and-warning',
    0,
    0,
    1,
    [
      { data: 1, clk: 1, rst: 1, hold: 4 },
      { data: 2, clk: 0, rst: 1, hold: 4 },
      { data: 2, clk: 0, rst: 0, hold: 4 },
      { data: 3, clk: 1, rst: 0, hold: 4 },
      { data: 3, clk: 1, rst: 1, hold: 4 },
      { data: 3, clk: 0, rst: 1, hold: 4 },
    ],
    wordOptions('either', 4, 'little'),
    { ...dataChannels(4), clk: 4, rst: 5 },
    1_000_000,
    9_007_199_254_740_990n,
  );
  yield boundary(
    'sixteen-bit-bus',
    0,
    0,
    1,
    [
      { data: 0x1234, clk: 1, rst: 1, hold: 3 },
      { data: 0xabcd, clk: 0, rst: 1, hold: 3 },
      { data: 0xffff, clk: 1, rst: 1, hold: 3 },
    ],
    wordOptions('either', 0, 'little'),
    { ...dataChannels(16), clk: 16 },
    1_000_000,
    89n,
  );
  yield boundary(
    'nine-bit-small-value',
    0,
    0,
    1,
    [
      { data: 1, clk: 1, rst: 1, hold: 4 },
      { data: 1, clk: 0, rst: 1, hold: 4 },
      { data: 0x101, clk: 1, rst: 1, hold: 4 },
    ],
    wordOptions('either', 0, 'little'),
    { ...dataChannels(9), clk: 9 },
    1_000_000,
    131n,
    () => {
      const nineBit = parallelItemBytes(1, 9);
      const eightBit = parallelItemBytes(1, 8);
      if (nineBit.length !== 2 || nineBit[0] !== 0 || nineBit[1] !== 1 || eightBit.length !== 1 || eightBit[0] !== 1)
        throw new Error('Parallel binary items must use the configured bus width');
    },
  );
  yield boundary(
    'sparse-data-lines',
    0,
    0,
    1,
    [
      { data: 0b0010, clk: 1, rst: 1, hold: 4 },
      { data: 0b1000, clk: 0, rst: 1, hold: 4 },
      { data: 0b1010, clk: 1, rst: 1, hold: 4 },
    ],
    wordOptions('either', 0, 'little'),
    { d1: 0, d3: 1, clk: 2 },
    1_000_000,
    107n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 2048;
  const count = 8192;
  const random = randomWords(seed);
  let data = 0;
  let clk: 0 | 1 = 0;
  const items: ParallelItem[] = [];
  for (let index = 0; index < count; index++) {
    let next = random() & 0xff;
    if (next === data) next ^= 1;
    data = next;
    clk = clk ? 0 : 1;
    items.push({ data, clk, rst: 1, hold: 16 });
  }
  const config: ParallelCase = {
    name: 'seeded-long-bus',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialData: 0,
    initialClk: 0,
    initialRst: 1,
    initialSamples: 2,
    channels: { ...dataChannels(8), clk: 8 },
    options: wordOptions('either', 0, 'little'),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const result = plan(this, items, perBlock);
      for (let offset = 0; offset < items.length; offset += perBlock) {
        const blockIndex = Math.floor(offset / perBlock);
        const block = blockAt(result, blockIndex);
        const data = items.slice(offset, offset + perBlock);
        const samples = data.reduce((sum, item) => sum + item.hold, 0) + (offset === 0 ? this.initialSamples : 0);
        yield {
          data,
          expected: block.frames,
          expectedAnnotations: annotations(block, 4),
          annotationCount: block.annotations.length,
          payloadBits: samples * 8,
        };
      }
    },
  };
  yield config;
}
