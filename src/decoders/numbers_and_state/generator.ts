import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { formatNumber, interpretPattern, parseEnumMap, wireInteger } from './index.js';
import type { NumbersAndStateOptions } from './index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export interface NumbersAndStateItem {
  readonly bits: number;
  readonly hold: number;
  readonly clk: 0 | 1;
}

export interface NumbersAndStateCase extends RoundtripCase<NumbersAndStateItem> {
  readonly initialBits: number;
  readonly initialClk: 0 | 1;
  readonly initialSamples: number;
  readonly bitcount: number;
}

interface NumbersAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

interface NumbersBlock {
  readonly annotations: NumbersAnnotation[];
  readonly frames: ExpectedFrame[];
}

interface NumbersPlan {
  readonly blocks: readonly NumbersBlock[];
  readonly totalSamples: number;
}

function optionsOf(config: NumbersAndStateCase): NumbersAndStateOptions {
  const options = config.options;
  return {
    clkedge: String(options.clkedge ?? 'rising'),
    count: Number(options.count ?? 0),
    interp: String(options.interp ?? 'unsigned'),
    fracbits: Number(options.fracbits ?? 0),
    mapping: String(options.mapping ?? 'enumtext.json'),
    format: String(options.format ?? '-'),
  };
}

function plan(config: NumbersAndStateCase, items: readonly NumbersAndStateItem[], blockSize: number): NumbersPlan {
  const options = optionsOf(config);
  const enumMap = parseEnumMap(options.mapping);
  const haveClock = config.channels.clk !== undefined;
  const connectedBits = Object.keys(config.channels)
    .filter((id) => id.startsWith('bit'))
    .map((id) => Number(id.slice(3)))
    .sort((left, right) => left - right);
  const blocks: NumbersBlock[] = [];
  const mask = (1n << BigInt(config.bitcount)) - 1n;
  let start = config.startSample;
  let sample = config.startSample + BigInt(config.initialSamples);
  let previousPattern = BigInt(config.initialBits) & mask;
  let previousBits = previousPattern;
  let previousClk = config.initialClk;

  const emitAnnotation = (event: number, annotation: NumbersAnnotation): void => {
    const block = Math.floor(event / blockSize);
    const target = (blocks[block] ??= { annotations: [], frames: [] });
    target.annotations.push(annotation);
  };
  const emitFrame = (event: number, frame: ExpectedFrame): void => {
    const block = Math.floor(event / blockSize);
    (blocks[block] ??= { annotations: [], frames: [] }).frames.push(frame);
  };
  const handle = (event: number, end: bigint, pattern: bigint): void => {
    const raw = pattern.toString(2).padStart(config.bitcount, '0');
    emitAnnotation(event, { ss: start, es: end, classIndex: 0, texts: [raw] });
    emitFrame(event, {
      ss: start,
      es: end,
      protoId: 'numbers_and_state',
      kind: 'protocol',
      data: ['RAW', [config.bitcount, wireInteger(pattern)]],
    });
    const interpreted = interpretPattern(pattern, options, config.bitcount, enumMap);
    if (!interpreted) return;
    emitFrame(event, {
      ss: start,
      es: end,
      protoId: 'numbers_and_state',
      kind: 'protocol',
      data: ['NUMBER', interpreted.value],
    });
    const formatted = formatNumber(interpreted.value, interpreted.kind, config.bitcount, options.format);
    if (!formatted) return;
    emitAnnotation(event, { ss: start, es: end, classIndex: 1, texts: formatted });
    if (options.interp === 'enum') {
      const code = pattern < 32n ? Number(pattern) : 32;
      emitAnnotation(event, { ss: start, es: end, classIndex: 2 + code, texts: formatted });
      emitFrame(event, {
        ss: start,
        es: end,
        protoId: 'numbers_and_state',
        kind: 'protocol',
        data: ['ENUM', [interpreted.value, formatted]],
      });
    }
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const bits = BigInt(item.bits) & mask;
    const triggered = haveClock
      ? selectedEdge(options.clkedge, previousClk, item.clk)
      : connectedBits.some((bit) => ((bits >> BigInt(bit)) & 1n) !== ((previousBits >> BigInt(bit)) & 1n));
    if (triggered && bits !== previousPattern) {
      handle(index, sample, previousPattern);
      start = sample;
      previousPattern = bits;
    }
    previousBits = bits;
    previousClk = item.clk;
    sample += BigInt(item.hold);
  }
  return { blocks, totalSamples: Number(sample - config.startSample) };
}

function selectedEdge(edge: string, previous: number, current: number): boolean {
  if (edge === 'rising') return !previous && !!current;
  if (edge === 'falling') return !!previous && !current;
  return previous !== current;
}

function annotations(block: NumbersBlock | undefined, limit = Infinity): ExpectedFrame[] {
  return (block?.annotations ?? []).slice(0, limit).map((annotation) => ({ ...annotation }));
}

function blocksOf(planResult: NumbersPlan, index: number): NumbersBlock {
  return planResult.blocks[index] ?? { annotations: [], frames: [] };
}

function boundary(
  name: string,
  initialBits: number,
  items: readonly NumbersAndStateItem[],
  options: Record<string, OptionValue>,
  channels: Record<string, number>,
  bitcount: number,
  sampleRate: number,
  startSample: bigint,
): NumbersAndStateCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x4e554d42,
    sampleRate,
    startSample,
    initialBits,
    initialClk: 0,
    initialSamples: 2,
    bitcount,
    channels,
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const result = plan(this, items, items.length);
      const block = blocksOf(result, 0);
      yield {
        data: items,
        expected: block.frames,
        expectedAnnotations: annotations(block),
        annotationCount: block.annotations.length,
        payloadBits: (this.initialSamples + items.reduce((sum, item) => sum + item.hold, 0)) * bitcount,
      };
    },
  };
}

function bitChannels(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`bit${index}`, index]));
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4e554d42,
}: GenerationOptions = {}): Iterable<NumbersAndStateCase> {
  yield boundary(
    'unsigned-four-bit',
    0,
    [
      { bits: 3, hold: 5, clk: 0 },
      { bits: 12, hold: 6, clk: 0 },
      { bits: 5, hold: 4, clk: 0 },
      { bits: 0, hold: 7, clk: 0 },
    ],
    { clkedge: 'rising', count: 4, interp: 'unsigned', fracbits: 0, mapping: 'enumtext.json', format: 'bin' },
    bitChannels(4),
    4,
    1_000_000,
    17n,
  );
  yield boundary(
    'signed-eight-bit',
    0,
    [
      { bits: 0x7f, hold: 4, clk: 0 },
      { bits: 0x80, hold: 5, clk: 0 },
      { bits: 0xff, hold: 3, clk: 0 },
      { bits: 0x01, hold: 6, clk: 0 },
    ],
    { clkedge: 'rising', count: 8, interp: 'signed', fracbits: 0, mapping: 'enumtext.json', format: 'hex' },
    bitChannels(8),
    8,
    2_000_000,
    31n,
  );
  yield boundary(
    'fixed-point',
    0,
    [
      { bits: 0x18, hold: 5, clk: 0 },
      { bits: 0x30, hold: 4, clk: 0 },
      { bits: 0x08, hold: 6, clk: 0 },
      { bits: 0x00, hold: 3, clk: 0 },
    ],
    { clkedge: 'rising', count: 8, interp: 'fixpoint', fracbits: 4, mapping: 'enumtext.json', format: '-' },
    bitChannels(8),
    8,
    4_000_000,
    53n,
  );
  yield boundary(
    'half-precision',
    0,
    [
      { bits: 0x3c00, hold: 4, clk: 0 },
      { bits: 0xc000, hold: 5, clk: 0 },
      { bits: 0x3800, hold: 3, clk: 0 },
      { bits: 0x0000, hold: 6, clk: 0 },
    ],
    { clkedge: 'rising', count: 16, interp: 'ieee754', fracbits: 0, mapping: 'enumtext.json', format: '-' },
    bitChannels(16),
    16,
    1_000_000,
    9_007_199_254_740_990n,
  );
  yield boundary(
    'enum-inline-table',
    0,
    [
      { bits: 1, hold: 4, clk: 0 },
      { bits: 2, hold: 5, clk: 0 },
      { bits: 3, hold: 3, clk: 0 },
      { bits: 1, hold: 4, clk: 0 },
      { bits: 2, hold: 6, clk: 0 },
    ],
    {
      clkedge: 'rising',
      count: 3,
      interp: 'enum',
      fracbits: 0,
      mapping: '{"zero":0,"one":1,"two":2,"three":3}',
      format: '-',
    },
    bitChannels(3),
    3,
    1_000_000,
    71n,
  );
  yield boundary(
    'clocked-sixteen-bit',
    0,
    [
      { bits: 0x1234, hold: 4, clk: 1 },
      { bits: 0xabcd, hold: 4, clk: 1 },
      { bits: 0xabcd, hold: 4, clk: 0 },
      { bits: 0xabcd, hold: 4, clk: 1 },
      { bits: 0x0001, hold: 3, clk: 1 },
      { bits: 0x0001, hold: 2, clk: 0 },
      { bits: 0x0001, hold: 4, clk: 1 },
    ],
    { clkedge: 'rising', count: 16, interp: 'unsigned', fracbits: 0, mapping: 'enumtext.json', format: 'hex' },
    { ...bitChannels(16), clk: 16 },
    16,
    1_000_000,
    89n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 1024;
  const count = 4096;
  const random = randomWords(seed);
  let value = 0;
  const items: NumbersAndStateItem[] = [];
  for (let index = 0; index < count; index++) {
    let next = random() & 0xffff;
    if (next === value) next ^= 1;
    value = next;
    items.push({ bits: value, hold: 16, clk: 0 });
  }
  const config: NumbersAndStateCase = {
    name: 'seeded-long-words',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialBits: 0,
    initialClk: 0,
    initialSamples: 2,
    bitcount: 16,
    channels: bitChannels(16),
    options: {
      clkedge: 'rising',
      count: 16,
      interp: 'unsigned',
      fracbits: 0,
      mapping: 'enumtext.json',
      format: 'hex',
    },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const result = plan(this, items, perBlock);
      for (let offset = 0; offset < items.length; offset += perBlock) {
        const blockIndex = Math.floor(offset / perBlock);
        const data = items.slice(offset, offset + perBlock);
        const block = blocksOf(result, blockIndex);
        const samples = data.reduce((sum, item) => sum + item.hold, 0) + (offset === 0 ? this.initialSamples : 0);
        yield {
          data,
          expected: block.frames,
          expectedAnnotations: annotations(block, 4),
          annotationCount: block.annotations.length,
          payloadBits: samples * this.bitcount,
        };
      }
    },
  };
  yield config;
}
