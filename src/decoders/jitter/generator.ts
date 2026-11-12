import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { edgeDetector, formatJitterDelta } from './index.js';

export interface JitterItem {
  readonly clk: 0 | 1;
  readonly sig: 0 | 1;
  readonly hold: number;
}

export interface JitterCase extends RoundtripCase<JitterItem> {
  readonly initialClk: 0 | 1;
  readonly initialSig: 0 | 1;
  readonly initialSamples: number;
}

interface JitterAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

interface JitterPlan {
  readonly blocks: readonly JitterAnnotation[][];
  readonly totalSamples: number;
}

function plan(config: JitterCase, items: readonly JitterItem[], blockSize: number): JitterPlan {
  const clkEdge = edgeDetector(String(config.options.clk_polarity));
  const sigEdge = edgeDetector(String(config.options.sig_polarity));
  const blocks: JitterAnnotation[][] = [];
  let state: 'CLK' | 'SIG' = 'CLK';
  let oldclk = 0;
  let oldsig = 0;
  let clkStart: bigint | null = null;
  let sigStart: bigint | null = null;
  let sample = config.startSample + BigInt(config.initialSamples);

  const emit = (index: number, annotation: JitterAnnotation): void => {
    const block = Math.floor(index / blockSize);
    (blocks[block] ??= []).push(annotation);
  };
  const handleClock = (clk: number, sig: number): boolean => {
    if (clkStart === sample) return true;
    if (clkEdge(oldclk, clk)) {
      clkStart = sample;
      state = 'SIG';
      return false;
    }
    if (sigStart !== null && sigStart !== sample && sigEdge(oldsig, sig)) {
      emit(index, { ss: sample, es: sample, classIndex: 2, texts: ['Missed signal', 'MS'] });
    }
    return true;
  };
  const handleSignal = (clk: number, sig: number): boolean => {
    if (sigStart === sample) return true;
    if (sigEdge(oldsig, sig)) {
      sigStart = sample;
      state = 'CLK';
      emit(index, {
        ss: clkStart!,
        es: sigStart,
        classIndex: 0,
        texts: [formatJitterDelta(Number(sigStart - clkStart!) / config.sampleRate)],
      });
      return false;
    }
    if (clkStart !== sample && clkEdge(oldclk, clk)) {
      emit(index, { ss: sample, es: sample, classIndex: 1, texts: ['Missed clock', 'MC'] });
    }
    return true;
  };

  let index = 0;
  for (const item of items) {
    const clk = item.clk;
    const sig = item.sig;
    const step = (): boolean => (state === 'CLK' ? handleClock(clk, sig) : handleSignal(clk, sig));
    while (!step());
    oldclk = clk;
    oldsig = sig;
    sample += BigInt(item.hold);
    index++;
  }

  return { blocks, totalSamples: Number(sample - config.startSample) };
}

function annotations(block: readonly JitterAnnotation[] | undefined, limit = Infinity): ExpectedFrame[] {
  return (block ?? []).slice(0, limit).map((annotation) => ({ ...annotation }));
}

function summary(config: JitterCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'jitter',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function boundary(
  name: string,
  initialClk: 0 | 1,
  initialSig: 0 | 1,
  items: readonly JitterItem[],
  options: Record<string, string>,
  sampleRate: number,
  startSample: bigint,
): JitterCase {
  return {
    name,
    kind: 'boundary',
    seed: 0x4a495454,
    sampleRate,
    startSample,
    initialClk,
    initialSig,
    initialSamples: 2,
    channels: { clk: 0, sig: 1 },
    options,
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const result = plan(this, items, items.length);
      yield {
        data: items,
        expected: [summary(this, result.totalSamples)],
        expectedAnnotations: annotations(result.blocks[0]),
        annotationCount: result.blocks[0]?.length ?? 0,
        payloadBits: this.initialSamples + items.reduce((sum, item) => sum + item.hold, 0),
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4a495454,
}: GenerationOptions = {}): Iterable<JitterCase> {
  yield boundary(
    'rising-jitter',
    0,
    0,
    [
      { clk: 1, sig: 0, hold: 4 },
      { clk: 1, sig: 1, hold: 5 },
      { clk: 1, sig: 0, hold: 3 },
      { clk: 0, sig: 0, hold: 4 },
      { clk: 1, sig: 0, hold: 4 },
      { clk: 1, sig: 1, hold: 4 },
      { clk: 0, sig: 0, hold: 2 },
    ],
    { clk_polarity: 'rising', sig_polarity: 'rising' },
    1_000_000,
    17n,
  );
  yield boundary(
    'zero-delta-and-misses',
    0,
    0,
    [
      { clk: 1, sig: 1, hold: 4 },
      { clk: 1, sig: 0, hold: 3 },
      { clk: 0, sig: 0, hold: 4 },
      { clk: 1, sig: 0, hold: 4 },
      { clk: 1, sig: 1, hold: 5 },
      { clk: 0, sig: 0, hold: 2 },
    ],
    { clk_polarity: 'both', sig_polarity: 'both' },
    2_000_000,
    31n,
  );
  yield boundary(
    'falling-clock',
    1,
    1,
    [
      { clk: 0, sig: 1, hold: 5 },
      { clk: 0, sig: 0, hold: 4 },
      { clk: 0, sig: 1, hold: 4 },
      { clk: 1, sig: 1, hold: 3 },
      { clk: 0, sig: 1, hold: 2 },
      { clk: 0, sig: 0, hold: 3 },
    ],
    { clk_polarity: 'falling', sig_polarity: 'both' },
    4_000_000,
    9_007_199_254_740_990n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = 1024;
  const count = 4096;
  const random = randomWords(seed);
  let clk: 0 | 1 = 0;
  let sig: 0 | 1 = 0;
  const items: JitterItem[] = [];
  for (let index = 0; index < count; index++) {
    if (random() & 1) clk = clk ? 0 : 1;
    else sig = sig ? 0 : 1;
    items.push({ clk, sig, hold: 256 + (random() & 31) });
  }
  const config: JitterCase = {
    name: 'seeded-long-edge-mix',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    initialClk: 0,
    initialSig: 0,
    initialSamples: 2,
    channels: { clk: 2, sig: 7 },
    options: { clk_polarity: 'both', sig_polarity: 'both' },
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
