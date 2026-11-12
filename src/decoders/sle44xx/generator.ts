import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export type Sle44xxItem =
  | { readonly kind: 'levels'; readonly rst: 0 | 1; readonly clk: 0 | 1; readonly io: 0 | 1; readonly samples?: number }
  | { readonly kind: 'reset-clock'; readonly pulses: number }
  | { readonly kind: 'byte'; readonly value: number }
  | { readonly kind: 'start' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'process'; readonly clocks: number };

export interface Sle44xxCase extends RoundtripCase<Sle44xxItem> {}

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function idle(): Sle44xxItem {
  return { kind: 'levels', rst: 0, clk: 0, io: 1, samples: 4 };
}

function resetPulse(clocked: boolean): Sle44xxItem[] {
  if (!clocked)
    return [
      { kind: 'levels', rst: 1, clk: 0, io: 1 },
      { kind: 'levels', rst: 0, clk: 0, io: 1 },
    ];
  return [
    { kind: 'levels', rst: 1, clk: 0, io: 1 },
    { kind: 'levels', rst: 1, clk: 1, io: 1 },
    { kind: 'levels', rst: 1, clk: 0, io: 1 },
    { kind: 'levels', rst: 0, clk: 0, io: 1 },
  ];
}

function readOperation(command: readonly number[], data: readonly number[]): Sle44xxItem[] {
  return [
    ...command.map((value) => ({ kind: 'byte', value }) as const),
    { kind: 'stop' },
    ...data.map((value) => ({ kind: 'byte', value }) as const),
  ];
}

function summary(): ExpectedFrame {
  return { protoId: 'sle44xx', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x534c4534,
}: GenerationOptions = {}): Iterable<Sle44xxCase> {
  const atr = [0x00, 0x11, 0x22, 0x33];
  const outgoing = [0xa1, 0xb2, 0xc3, 0xd4];
  const boundaryItems: Sle44xxItem[] = [
    idle(),
    ...resetPulse(true),
    ...atr.map((value) => ({ kind: 'byte', value }) as const),
    { kind: 'start' },
    ...readOperation([0x31, 0x00, 0x00], outgoing),
    idle(),
  ];
  const boundaryExpected: ExpectedFrame[] = [
    { classIndex: 0, texts: ['Reset', 'R'] },
    { classIndex: 5, texts: ['Answer To Reset: 00', 'ATR: 00', '00'] },
    { classIndex: 9, texts: ['Answer To Reset: 00 11 22 33', 'ATR: 00 11 22 33', '00 11 22 33'] },
    { classIndex: 2, texts: ['Start', 'ST', 'S'] },
    { classIndex: 10, texts: ['read security memory', 'RD-S'] },
    { classIndex: 3, texts: ['Stop', 'SP', 'P'] },
    { classIndex: 7, texts: ['Outgoing data: a1', 'Data: a1', 'a1'] },
    { classIndex: 11, texts: ['Outgoing: a1 b2 c3 d4', 'Out: a1 b2 c3 d4', 'a1 b2 c3 d4'] },
  ];
  yield {
    name: 'reset-atr-security-read',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 19n,
    channels: { rst: 1, clk: 3, io: 5 },
    options: {},
    chunkSamples: [1, 13, 211],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: boundaryItems,
        expected: [summary()],
        expectedAnnotations: boundaryExpected,
        annotationCount: 105,
        payloadBits: 89,
      };
    },
  };

  const writeExpected: ExpectedFrame[] = [
    { classIndex: 1, texts: ['Interrupt', 'Intr', 'I'] },
    { classIndex: 2, texts: ['Start', 'ST', 'S'] },
    { classIndex: 10, texts: ['update main memory, addr ff, data 5a', 'WR-M @ff =5a'] },
    { classIndex: 3, texts: ['Stop', 'SP', 'P'] },
  ];
  yield {
    name: 'interrupt-write-processing',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { rst: 0, clk: 2, io: 4 },
    options: {},
    chunkSamples: [2, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data: Sle44xxItem[] = [
        idle(),
        ...resetPulse(false),
        { kind: 'start' },
        { kind: 'byte', value: 0x38 },
        { kind: 'byte', value: 0xff },
        { kind: 'byte', value: 0x5a },
        { kind: 'stop' },
        { kind: 'process', clocks: 8 },
        idle(),
      ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: writeExpected,
        annotationCount: 32,
        payloadBits: 32,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const pulseCount = 65_536;
  const blocks = Math.max(2, Math.ceil(required / (pulseCount + 8)));
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { rst: 1, clk: 3, io: 5 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const value = random() & 0xff;
        const data: Sle44xxItem[] = [];
        if (block === 0) data.push(idle(), ...resetPulse(true));
        data.push({ kind: 'byte', value });
        data.push({ kind: 'levels', rst: 1, clk: 0, io: 1 });
        data.push({ kind: 'reset-clock', pulses: pulseCount });
        data.push({ kind: 'levels', rst: 0, clk: 0, io: 1 });
        const expectedAnnotations: ExpectedFrame[] = [];
        if (block === 0) expectedAnnotations.push({ classIndex: 0, texts: ['Reset', 'R'] });
        expectedAnnotations.push(
          { classIndex: 5, texts: [`Answer To Reset: ${hex2(value)}`, `ATR: ${hex2(value)}`, hex2(value)] },
          { classIndex: 9, texts: [`Answer To Reset: ${hex2(value)}`, `ATR: ${hex2(value)}`, hex2(value)] },
          { classIndex: 0, texts: ['Reset', 'R'] },
        );
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: block === 0 ? 12 : 11,
          payloadBits: pulseCount + (block === 0 ? 9 : 8),
        };
      }
    },
  };
}
