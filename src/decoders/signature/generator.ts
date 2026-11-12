import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { signatureText, updateSignature } from './index.js';

export interface SignatureStep {
  readonly start: 0 | 1;
  readonly stop: 0 | 1;
  readonly data: 0 | 1;
}

export interface SignatureCase extends RoundtripCase<SignatureStep> {}

function frameSteps(bits: readonly number[], startActive: 0 | 1, stopActive: 0 | 1): SignatureStep[] {
  const startInactive = (startActive ^ 1) as 0 | 1;
  const stopInactive = (stopActive ^ 1) as 0 | 1;
  const steps: SignatureStep[] = [
    { start: startInactive, stop: stopInactive, data: 0 },
    { start: startActive, stop: stopInactive, data: (bits[0] ?? 0) as 0 | 1 },
  ];
  for (let index = 1; index < bits.length; index++)
    steps.push({ start: startActive, stop: stopInactive, data: bits[index] as 0 | 1 });
  steps.push({ start: startActive, stop: stopActive, data: (bits.at(-1) ?? 0) as 0 | 1 });
  return steps;
}

function signature(bits: readonly number[]): string {
  let register = 0;
  for (const bit of bits) register = updateSignature(register, bit);
  return signatureText(register);
}

export function frameAnnotations(bits: readonly number[], annbits: boolean): ExpectedFrame[] {
  const result: ExpectedFrame[] = [];
  if (annbits)
    result.push({
      classIndex: 2,
      texts: [`START<${bits[0] ?? 0}>`, `STR<${bits[0] ?? 0}>`, `S<${bits[0] ?? 0}>`],
    });
  if (annbits)
    for (let index = 1; index < bits.length; index++)
      result.push({ classIndex: bits[index]!, texts: [`${bits[index]}`] });
  if (annbits) result.push({ classIndex: 3, texts: ['STOP', 'STP', 'P'] });
  result.push({ classIndex: 4, texts: [signature(bits)] });
  return result;
}

function summary(): ExpectedFrame {
  return { protoId: 'signature', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x5349474e,
}: GenerationOptions = {}): Iterable<SignatureCase> {
  const risingBits = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0];
  yield {
    name: 'rising-gates-with-bits',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 13n,
    channels: { start: 0, stop: 2, clk: 4, data: 6 },
    options: { start_edge: 'rising', stop_edge: 'rising', clk_edge: 'falling', annbits: 'yes' },
    chunkSamples: [1, 9, 173],
    minimumPayloadBits: 0,
    *generate() {
      const data = frameSteps(risingBits, 1, 1);
      const expectedAnnotations = frameAnnotations(risingBits, true);
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length,
      };
    },
  };

  const fallingBits = [1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0];
  yield {
    name: 'falling-gates-without-bit-annotations',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { start: 1, stop: 3, clk: 5, data: 7 },
    options: { start_edge: 'falling', stop_edge: 'falling', clk_edge: 'rising', annbits: 'no' },
    chunkSamples: [2, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data = frameSteps(fallingBits, 0, 0);
      const expectedAnnotations = frameAnnotations(fallingBits, false);
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerFrame = 64;
  const edgesPerFrame = bitsPerFrame + 2;
  const frameCount = Math.ceil(required / edgesPerFrame);
  const perBlock = 512;
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { start: 0, stop: 1, clk: 2, data: 3 },
    options: { start_edge: 'rising', stop_edge: 'rising', clk_edge: 'falling', annbits: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < frameCount; offset += perBlock) {
        const count = Math.min(perBlock, frameCount - offset);
        const data: SignatureStep[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const bits = Array.from({ length: bitsPerFrame }, () => random() & 1);
          data.push(...frameSteps(bits, 1, 1));
          if (index === 0 || index === count - 1) expectedAnnotations.push({ classIndex: 4, texts: [signature(bits)] });
        }
        yield {
          data,
          expected: offset === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: count * edgesPerFrame,
        };
      }
    },
  };
}
