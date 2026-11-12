import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { bitpack } from '../common.js';

export type SdqItem = { readonly kind: 'bit'; readonly value: 0 | 1 } | { readonly kind: 'break' };

export interface SdqCase extends RoundtripCase<SdqItem> {
  readonly initialSamples: number;
}

interface SdqAnnotation {
  readonly ss: bigint;
  readonly es: bigint;
  readonly classIndex: number;
  readonly texts: readonly string[];
}

export function sdqWidth(sampleRate: number, bitrate: number): number {
  return sampleRate / bitrate;
}

export function sdqLowSamples(item: SdqItem, width: number): number {
  if (item.kind === 'break') return Math.floor(width * 1.2) + 1;
  return item.value ? Math.max(1, Math.floor(width / 2)) : Math.floor(width / 2) + 1;
}

export function sdqHighSamples(width: number): number {
  return Math.max(1, Math.floor(width / 2));
}

function plan(
  config: SdqCase,
  items: readonly SdqItem[],
): { annotations: SdqAnnotation[]; bits: number; totalSamples: number } {
  const width = sdqWidth(config.sampleRate, Number(config.options.bitrate));
  const high = sdqHighSamples(width);
  const truncWidth = BigInt(Math.trunc(width));
  let fall = config.startSample + BigInt(config.initialSamples);
  let byteStart: bigint | null = null;
  let byteBits: number[] = [];
  let bits = 0;
  const annotations: SdqAnnotation[] = [];

  for (const item of items) {
    const low = sdqLowSamples(item, width);
    if (low < 1) throw new Error('SDQ bit width is too small');
    const rise = fall + BigInt(low);
    if (item.kind === 'break') {
      annotations.push({ ss: fall, es: rise, classIndex: 2, texts: ['Break', 'BR'] });
      byteStart = null;
      byteBits = [];
    } else {
      bits++;
      if (byteStart === null) byteStart = fall;
      byteBits.push(item.value);
      annotations.push({
        ss: fall,
        es: fall + truncWidth,
        classIndex: 0,
        texts: [`Bit: ${item.value}`, String(item.value)],
      });
      if (byteBits.length === 8) {
        const value = bitpack(byteBits);
        const text = `0x${value.toString(16).padStart(2, '0')}`;
        annotations.push({ ss: byteStart, es: fall + truncWidth, classIndex: 1, texts: [`Byte: ${text}`, text] });
        byteStart = null;
        byteBits = [];
      }
    }
    fall = rise + BigInt(high);
  }
  return { annotations, bits, totalSamples: Number(fall - config.startSample) };
}

function expectedAnnotations(annotations: readonly SdqAnnotation[]): ExpectedFrame[] {
  return annotations.map((item) => ({
    ss: item.ss,
    es: item.es,
    classIndex: item.classIndex,
    texts: item.texts,
  }));
}

function summary(config: SdqCase, totalSamples: number): ExpectedFrame {
  return {
    protoId: 'sdq',
    kind: 'summary',
    ss: config.startSample,
    es: config.startSample + BigInt(totalSamples),
  };
}

function items(values: readonly (0 | 1 | 'break')[]): SdqItem[] {
  return values.map((value) => (value === 'break' ? { kind: 'break' } : { kind: 'bit', value }));
}

function bitsOf(value: number): (0 | 1)[] {
  return Array.from({ length: 8 }, (_, bit) => ((value >>> bit) & 1) as 0 | 1);
}

function boundary(
  name: string,
  values: readonly (0 | 1 | 'break')[],
  sampleRate: number,
  bitrate: number,
  startSample: bigint,
): SdqCase {
  const config: SdqCase = {
    name,
    kind: 'boundary',
    seed: 0x534451,
    sampleRate,
    startSample,
    initialSamples: 3,
    channels: { sdq: 6 },
    options: { bitrate },
    chunkSamples: [1, 19, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = items(values);
      const result = plan(config, data);
      yield {
        data,
        expected: [summary(config, result.totalSamples)],
        expectedAnnotations: expectedAnnotations(result.annotations),
        annotationCount: result.annotations.length,
        payloadBits: Math.max(1, result.bits),
      };
    },
  };
  return config;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x534451,
}: GenerationOptions = {}): Iterable<SdqCase> {
  yield boundary(
    'default-rate-mixed',
    [...bitsOf(0xff), ...bitsOf(0x00), ...bitsOf(0x55), 'break', ...bitsOf(0xaa)],
    984_250,
    98_425,
    11n,
  );
  yield boundary(
    'narrow-pulses',
    [...bitsOf(0x81).slice(0, 3), 'break', ...bitsOf(0x7e)],
    400_000,
    100_000,
    9_007_199_254_740_990n,
  );
  yield boundary(
    'wide-pulses-break-resync',
    ['break', ...bitsOf(0xc3), 'break', ...bitsOf(0x3c), ...bitsOf(0x00)],
    2_000_000,
    100_000,
    41n,
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalBits = Math.ceil(required / 8) * 8;
  const perBlock = 4096;
  const width = 20;
  const random = randomWords(seed);
  const allBits = Uint8Array.from({ length: totalBits }, () => (random() & 1) as 0 | 1);
  const high = sdqHighSamples(width);
  let totalSamples = 3;
  for (let index = 0; index < totalBits; index++)
    totalSamples += sdqLowSamples({ kind: 'bit', value: allBits[index] as 0 | 1 }, width) + high;
  const config: SdqCase = {
    name: 'seeded-long-bits',
    kind: 'long',
    seed,
    sampleRate: 1_968_500,
    startSample: 0n,
    initialSamples: 3,
    channels: { sdq: 1 },
    options: { bitrate: 98_425 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let fallOffset = 3;
      for (let offset = 0, block = 0; offset < totalBits; offset += perBlock, block++) {
        const length = Math.min(perBlock, totalBits - offset);
        const data: SdqItem[] = Array.from({ length }, (_, index) => ({
          kind: 'bit',
          value: (allBits[offset + index] ?? 0) as 0 | 1,
        }));
        const firstFall = fallOffset;
        for (const item of data) {
          fallOffset += sdqLowSamples(item, width) + high;
        }
        yield {
          data,
          expected:
            block === 0
              ? [
                  {
                    protoId: 'sdq',
                    kind: 'summary',
                    ss: config.startSample,
                    es: config.startSample + BigInt(totalSamples),
                  },
                ]
              : [],
          expectedAnnotations: [
            {
              ss: BigInt(firstFall),
              es: BigInt(firstFall + width),
              classIndex: 0,
              texts: [
                `Bit: ${data[0]!.kind === 'bit' ? data[0]!.value : 0}`,
                String(data[0]!.kind === 'bit' ? data[0]!.value : 0),
              ],
            },
          ],
          annotationCount: data.length + data.length / 8,
          payloadBits: data.length,
        };
      }
    },
  };
  yield config;
}
