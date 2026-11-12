import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface RgbLedSpiCase extends RoundtripCase<number> {}

const CHAIN = [
  {
    decoder: 'spi',
    options: {
      cs_polarity: 'active-low',
      cpol: 0,
      cpha: 0,
      bitorder: 'msb-first',
      wordsize: 8,
    },
  },
] as const;

const SUMMARY: ExpectedFrame = { protoId: 'rgb_led_spi', kind: 'summary' };

function rgbAnnotations(bytes: readonly number[]): ExpectedFrame[] {
  const result: ExpectedFrame[] = [];
  for (let index = 0; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    result.push({ classIndex: 0, texts: [`#${value.toString(16).toLowerCase().padStart(6, '0')}`] });
  }
  return result;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x52474253,
}: GenerationOptions = {}): Iterable<RgbLedSpiCase> {
  yield {
    name: 'three-byte-colours',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { clk: 3, mosi: 7, cs: 1 },
    options: {},
    chunkSamples: [1, 7, 31, 257],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x12, 0x34, 0x56, 0xab, 0xcd, 0xef];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: rgbAnnotations(data),
        annotationCount: data.length / 3,
        payloadBits: data.length * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const words = Math.ceil(required / (8 * 3)) * 3;
  const blockWords = Math.ceil(words / 6) * 3;
  yield {
    name: 'seeded-long-colour-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: { clk: 0, mosi: 6, cs: 2 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      let remaining = words,
        first = true;
      while (remaining > 0) {
        const count = Math.min(blockWords, remaining);
        const data = Array.from({ length: count }, () => random() & 0xff);
        const firstValue = ((data[0]! << 16) | (data[1]! << 8) | data[2]!) >>> 0;
        yield {
          data,
          expected: first ? [SUMMARY] : [],
          expectedAnnotations: [
            {
              classIndex: 0,
              texts: [`#${firstValue.toString(16).toLowerCase().padStart(6, '0')}`],
            },
          ],
          annotationCount: data.length / 3,
          payloadBits: data.length * 8,
        };
        remaining -= count;
        first = false;
      }
    },
  };
}
