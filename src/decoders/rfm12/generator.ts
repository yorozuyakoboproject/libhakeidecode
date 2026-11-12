import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Rfm12Frame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Rfm12Case extends RoundtripCase<Rfm12Frame> {}

const CHANNELS = { clk: 3, miso: 0, mosi: 7, cs: 1 } as const;
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
const SUMMARY: ExpectedFrame = { protoId: 'rfm12', kind: 'summary' };

function transaction(mosi: readonly number[], miso: readonly number[] = []): Rfm12Frame {
  return { mosi, miso };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x52464d31,
}: GenerationOptions = {}): Iterable<Rfm12Case> {
  yield {
    name: 'boundary-all-command-families',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
          transaction([0x80, 0xb5], [0x00, 0x00]),
          transaction([0x82, 0xe8], [0x00, 0x00]),
          transaction([0xa5, 0x3c], [0x00, 0x00]),
          transaction([0xc6, 0x2a], [0x00, 0x00]),
          transaction([0x94, 0xe7], [0x00, 0x00]),
          transaction([0xc2, 0x5a], [0x00, 0x00]),
          transaction([0xca, 0xa9], [0x00, 0x00]),
          transaction([0xce, 0x2d], [0x00, 0x00]),
          transaction([0xb0, 0x00], [0x12, 0x34]),
          transaction([0xc4, 0x7b], [0x00, 0x00]),
          transaction([0x98, 0xa3], [0x00, 0x00]),
          transaction([0xcc, 0x2a], [0x00, 0x00]),
          transaction([0xb8, 0x55], [0x00, 0x00]),
          transaction([0xfe, 0x00], [0x00, 0x00]),
          transaction([0xe7, 0x05], [0x00, 0x00]),
          transaction([0xc8, 0x00], [0x00, 0x00]),
          transaction([0xc0, 0x5a], [0x00, 0x00]),
          transaction([0x00, 0x00], [0xe1, 0x9f]),
          transaction([0x42, 0x99], [0xaa, 0xbb]),
        ],
        counts = [8, 13, 3, 3, 6, 4, 8, 2, 2, 10, 5, 8, 2, 1, 2, 1, 3, 19, 1];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(0, 'Configuration command', 'Configuration'),
          annotation(1, 'Internal data register', 'el'),
          annotation(2, 'FIFO mode', 'ef'),
          annotation(0, 'Power management', 'Power'),
          annotation(0, 'Frequency setting', 'Frequency'),
          annotation(0, 'F = 1340.0000'),
          annotation(0, 'Data rate command', 'Data rate'),
          annotation(0, 'Receiver control command'),
          annotation(0, 'Data filter command'),
          annotation(0, 'FIFO and reset command'),
          annotation(0, 'Synchron pattern command'),
          annotation(0, 'Pattern: 0x2D2D'),
          annotation(0, 'FIFO read command', 'FIFO read'),
          annotation(3, 'Data: 34'),
          annotation(0, 'AFC command'),
          annotation(0, 'Transceiver control command'),
          annotation(0, 'PLL setting command'),
          annotation(0, 'Transmitter register command', 'Transmit'),
          annotation(0, 'Software reset command'),
          annotation(0, 'Wake-up timer command', 'Timer'),
          annotation(0, 'Low duty cycle command'),
          annotation(0, 'Low battery detector command'),
          annotation(0, 'Status read command', 'Status'),
          annotation(5, 'Power on Reset'),
          annotation(0, 'Unknown command: 42 99 (reply: aa bb)!'),
        ],
        annotationCount: counts.reduce((sum, count) => sum + count, 0),
        payloadBits: data.reduce((sum, item) => sum + item.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    total = Math.ceil(required / 16),
    perBlock = 8192,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-software-reset-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(perBlock, total - block * perBlock),
          data: Rfm12Frame[] = [];
        for (let index = 0; index < count; index++) data.push(transaction([0xfe, random() & 0xff]));
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [annotation(0, 'Software reset command')],
          annotationCount: data.length,
          payloadBits: data.length * 16,
        };
      }
    },
  };
}
