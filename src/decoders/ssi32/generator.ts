import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SsiMessage {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Ssi32Case extends RoundtripCase<SsiMessage> {}

export interface SsiWordTiming {
  readonly ss: bigint;
  readonly es: bigint;
}

const SPI_OPTIONS = {
  cs_polarity: 'active-low',
  cpol: 0,
  cpha: 0,
  bitorder: 'msb-first',
  wordsize: 8,
} as const;

export function ssiWordTiming(startSample: bigint, halfUnits: number, wordIndex: number): SsiWordTiming {
  return {
    ss: startSample + BigInt(Math.round((6 + wordIndex * 24) * halfUnits)),
    es: startSample + BigInt(Math.round((27 + wordIndex * 24) * halfUnits)),
  };
}

function annotation(timing: SsiWordTiming, classIndex: number): ExpectedFrame {
  return { ss: timing.ss, es: timing.es, classIndex };
}

function summary(): ExpectedFrame {
  return { protoId: 'ssi32', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53534933,
}: GenerationOptions = {}): Iterable<Ssi32Case> {
  const ack: SsiMessage = {
    mosi: [0x80, 0x01, 0x02, 0x03],
    miso: [0x9a, 0x04, 0x05, 0x06],
  };
  const ctrl: SsiMessage = {
    mosi: [0x11, 0x22, 0x02, 0xaa, 0xde, 0xad, 0x00, 0x00],
    miso: [0x33, 0x44, 0x02, 0xbb, 0x12, 0x34, 0x00, 0x00],
  };
  const boundaryStart = 7n;
  const boundaryRate = 4_000_000;
  yield {
    name: 'ack-and-control',
    kind: 'boundary',
    seed,
    sampleRate: boundaryRate,
    startSample: boundaryStart,
    channels: { clk: 3, miso: 0, mosi: 7, cs: 1 },
    options: { msgsize: 8 },
    chunkSamples: [1, 17, 127, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'spi', options: SPI_OPTIONS }],
    *generate() {
      const first = ssiWordTiming(boundaryStart, 1, 0);
      const control = ssiWordTiming(boundaryStart, 1, 4);
      const controlEnd = ssiWordTiming(boundaryStart, 1, 9);
      yield {
        data: [ack, ctrl],
        expected: [summary()],
        expectedAnnotations: [
          annotation(first, 1),
          annotation(first, 3),
          { ss: control.ss, es: controlEnd.es, classIndex: 0 },
          { ss: control.ss, es: controlEnd.es, classIndex: 2 },
        ],
        annotationCount: 4,
        payloadBits: 12 * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalMessages = Math.ceil(required / 32);
  const messagesPerBlock = 256;
  const sampleRate = 4_000_000;
  const startSample = 0n;
  yield {
    name: 'seeded-long-acks',
    kind: 'long',
    seed,
    sampleRate,
    startSample,
    channels: { clk: 3, miso: 0, mosi: 7, cs: 1 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'spi', options: SPI_OPTIONS }],
    *generate() {
      const random = randomWords(seed);
      let messageIndex = 0;
      for (let offset = 0; offset < totalMessages; offset += messagesPerBlock) {
        const count = Math.min(messagesPerBlock, totalMessages - offset);
        const data: SsiMessage[] = [];
        for (let index = 0; index < count; index++) {
          data.push({
            mosi: [0x80 | (random() & 0x7f), random() & 0xff, random() & 0xff, random() & 0xff],
            miso: [random() & 0xff, random() & 0xff, random() & 0xff, random() & 0xff],
          });
        }
        const first = ssiWordTiming(startSample, 1, messageIndex * 4);
        const last = ssiWordTiming(startSample, 1, (messageIndex + count - 1) * 4);
        yield {
          data,
          expected: offset === 0 ? [summary()] : [],
          expectedAnnotations: [annotation(first, 1), annotation(first, 3), annotation(last, 1), annotation(last, 3)],
          annotationCount: count * 2,
          payloadBits: count * 32,
        };
        messageIndex += count;
      }
    },
  };
}
