import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Cc1101Frame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Cc1101Case extends RoundtripCase<Cc1101Frame> {}

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
const SUMMARY: ExpectedFrame = { protoId: 'cc1101', kind: 'summary' };
const STATUS = 0x0e;

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function transaction(mosi: readonly number[], response: readonly number[] = []): Cc1101Frame {
  return { mosi, miso: [STATUS, ...response] };
}

function statusAnnotation(commandRead = false): ExpectedFrame {
  const fifo = STATUS & 0x0f;
  return {
    classIndex: 6,
    texts: [
      `Status = 0E; STATE is IDLE, ${fifo} bytes ${commandRead ? 'available in RX FIFO' : 'free in TX FIFO'}`,
      'Status = 0E',
    ],
  };
}

function annotation(classIndex: number, text: string): ExpectedFrame {
  return { classIndex, texts: [text] };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x43433131,
}: GenerationOptions = {}): Iterable<Cc1101Case> {
  yield {
    name: 'boundary-commands-registers-status-and-malformed',
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
        transaction([0x00, 0x2e]),
        transaction([0xb1, 0x00], [0x14]),
        transaction([0x7e, 0x00, 0xc0, 0x80]),
        transaction([0xff, 0x00, 0x00], [0xaa, 0x55]),
        transaction([0xf0, 0x00], [0x99]),
        transaction([0x34]),
        transaction([0x37]),
        transaction([0x70]),
        transaction([0xae, 0x00], [0x00]),
        transaction([0x00]),
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          statusAnnotation(),
          annotation(2, 'Write: IOCFG2 (00) = 2E'),
          statusAnnotation(),
          annotation(1, 'Read: VERSION (31) = 14'),
          statusAnnotation(),
          annotation(4, 'Burst write: PATABLE (3E) = 00 C0 80'),
          statusAnnotation(true),
          annotation(3, 'Burst read: FIFO (3F) = AA 55'),
          statusAnnotation(true),
          annotation(5, 'Status read: PARTNUM (30) = 99'),
          annotation(0, 'Strobe SRX'),
          statusAnnotation(),
          annotation(0, 'Strobe '),
          statusAnnotation(),
          annotation(7, 'unknown command'),
          statusAnnotation(),
          statusAnnotation(),
          annotation(1, 'Read: TEST0 (2E) = 00'),
          statusAnnotation(),
          annotation(7, 'missing data bytes'),
        ],
        annotationCount: data.length * 2,
        payloadBits: data.reduce((sum, frame) => sum + frame.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerTransaction = 16,
    total = Math.ceil(required / bitsPerTransaction),
    perBlock = 8192,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-register-writes',
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
          data: Cc1101Frame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const value = random() & 0xff;
          data.push(transaction([0x00, value]));
          if (index === 0 || index === count - 1) {
            expectedAnnotations.push(statusAnnotation(), annotation(2, `Write: IOCFG2 (00) = ${hex(value)}`));
          }
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length * 2,
          payloadBits: data.length * bitsPerTransaction,
        };
      }
    },
  };
}
