import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface MlxOperation {
  readonly address: number;
  readonly addressBits?: 7 | 10;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface MlxCase extends RoundtripCase<MlxOperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'mlx90614', kind: 'summary' };

function annotation(classIndex: number, text: string): ExpectedFrame {
  return { classIndex, texts: [text] };
}

function measurement(low: number, high: number): MlxOperation[] {
  return [
    { address: 0x5a, direction: 'write', data: [0x07], stop: false },
    {
      address: 0x5a,
      direction: 'write',
      data: [low, high, 0x00],
      repeatedStart: true,
      stop: true,
    },
  ];
}

function temperatureAnnotations(low: number, high: number): ExpectedFrame[] {
  const kelvin = (low | (high << 8)) * 0.02;
  return [
    annotation(0, `Temperature: ${(kelvin - 273.15).toFixed(2)} °C`),
    annotation(1, `Temperature: ${kelvin.toFixed(2)} K`),
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d4c58,
}: GenerationOptions = {}): Iterable<MlxCase> {
  yield {
    name: 'temperature-min-max-mid',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 29n,
    channels: { scl: 3, sda: 6 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [2, 19, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: MlxOperation[] = [...measurement(0x00, 0x00), ...measurement(0xff, 0xff), ...measurement(0x34, 0x12)];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          ...temperatureAnnotations(0x00, 0x00),
          ...temperatureAnnotations(0xff, 0xff),
          ...temperatureAnnotations(0x34, 0x12),
        ],
        annotationCount: 6,
        payloadBits: 162,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = Math.ceil(required / 4);
  yield {
    name: 'seeded-long-temperature-stream',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 0, sda: 1 },
    options: {},
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < 4; block++) {
        const data: MlxOperation[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        let payloadBits = 0;
        for (let index = 0; index < 8; index++) {
          const low = random() & 0xff;
          const high = random() & 0xff;
          data.push(...measurement(low, high));
          expectedAnnotations.push(...temperatureAnnotations(low, high));
          payloadBits += 54;
        }
        const fillers = Math.ceil(Math.max(0, perBlock - payloadBits) / 27);
        for (let index = 0; index < fillers; index++)
          data.push({
            address: 0x5a,
            direction: 'write',
            data: [random() & 0xff, random() & 0xff],
            stop: true,
          });
        payloadBits += fillers * 27;
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits,
        };
      }
    },
  };
}
