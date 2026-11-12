import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { st7735Description } from './index.js';

export interface St7735Byte {
  readonly value: number;
  readonly command: boolean;
}

export interface St7735Case extends RoundtripCase<St7735Byte> {}

const SUMMARY: ExpectedFrame = { protoId: 'st7735', kind: 'summary' };

function byteAnnotations(item: St7735Byte): ExpectedFrame[] {
  const result: ExpectedFrame[] = Array.from({ length: 8 }, (_, index) => ({
    classIndex: 0,
    texts: [String((item.value >>> (7 - index)) & 1)],
  }));
  result.push({
    classIndex: item.command ? 1 : 2,
    texts: [item.value.toString(16).toUpperCase().padStart(2, '0')],
  });
  return result;
}

function annotations(data: readonly St7735Byte[]): ExpectedFrame[] {
  const result: ExpectedFrame[] = [];
  let command = -1;
  let values: number[] = [];
  for (const item of data) {
    result.push(...byteAnnotations(item));
    if (!item.command) {
      if (values.length < 128) values.push(item.value);
      continue;
    }
    const text = st7735Description(command, values);
    if (text !== null) result.push({ classIndex: 3, texts: [text] });
    command = item.value;
    values = [];
  }
  return result;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x535437,
}: GenerationOptions = {}): Iterable<St7735Case> {
  yield {
    name: 'known-command-and-data',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 11n,
    channels: { cs: 0, clk: 1, mosi: 2, dc: 3 },
    options: {},
    chunkSamples: [1, 7, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data: St7735Byte[] = [
        { value: 0x2c, command: true },
        { value: 0x00, command: false },
        { value: 0x5a, command: false },
        { value: 0xff, command: false },
        { value: 0x36, command: true },
        { value: 0x08, command: false },
      ];
      const expected = annotations(data);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: expected,
        annotationCount: expected.length,
        payloadBits: data.length * 8,
      };
    },
  };
  yield {
    name: 'unknown-command-maximum-data',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { cs: 4, clk: 6, mosi: 2, dc: 0 },
    options: {},
    chunkSamples: [3, 17, 513],
    minimumPayloadBits: 0,
    *generate() {
      const data: St7735Byte[] = [{ value: 0xfe, command: true }];
      for (let index = 0; index < 128; index++) data.push({ value: index & 0xff, command: false });
      data.push({ value: 0x29, command: true }, { value: 0x00, command: false });
      const expected = annotations(data);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: expected.slice(0, 10).concat(expected.slice(-8)),
        annotationCount: expected.length,
        payloadBits: data.length * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerBlock = 32_768;
  const blocks = Math.ceil(required / (bytesPerBlock * 8));
  yield {
    name: 'seeded-long-display-stream',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { cs: 0, clk: 1, mosi: 2, dc: 3 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: St7735Byte[] = [{ value: 0x2c, command: true }];
        for (let index = 1; index < bytesPerBlock; index++) data.push({ value: random() & 0xff, command: false });
        const previousDescription = st7735Description(0x2c, []);
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations:
            block === 0
              ? byteAnnotations(data[0]!)
              : [...byteAnnotations(data[0]!), { classIndex: 3, texts: [previousDescription!] }],
          annotationCount: data.length * 9 + (block > 0 ? 1 : 0),
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
