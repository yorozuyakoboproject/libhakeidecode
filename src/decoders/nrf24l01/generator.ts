import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Nrf24l01Frame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Nrf24l01Case extends RoundtripCase<Nrf24l01Frame> {}

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
const SUMMARY: ExpectedFrame = { protoId: 'nrf24l01', kind: 'summary' };
const STATUS = 0x0e;

function transaction(mosi: readonly number[], response: readonly number[] = []): Nrf24l01Frame {
  return { mosi, miso: [STATUS, ...response] };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4e524632,
}: GenerationOptions = {}): Iterable<Nrf24l01Case> {
  yield {
    name: 'boundary-commands-payloads-errors-and-activate',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: { chip: 'nrf24l01' },
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
          transaction([0x20, 0x3b]),
          transaction([0x07, 0x00], [STATUS]),
          transaction([0x2a, 0xe7, 0xe7, 0xe7, 0xe7, 0xe7]),
          transaction([0x0a, 0, 0, 0, 0, 0], [0x11, 0x22, 0x33, 0x44, 0x55]),
          transaction([0xa0, 0x41, 0x42, 0x43]),
          transaction([0xb0, 0x00]),
          transaction([0x61, 0x00], [0x41]),
          transaction([0x60, 0x00], [0x20]),
          transaction([0xab, 0x35]),
          transaction([0xe1]),
          transaction([0xff]),
          transaction([0x50, 0x73]),
          transaction([0x50, 0x00]),
          transaction([0x5f]),
          transaction([0x00]),
          transaction([0x20]),
          transaction([0xff, 0x00]),
          transaction([0x1f, 0x00]),
        ],
        counts = [2, 3, 2, 3, 3, 3, 3, 3, 3, 2, 2, 2, 3, 2, 3, 2, 3, 3];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(2, 'Reg STATUS = "0E"'),
          annotation(0, 'Cmd W_REGISTER: CONFIG = "3B"'),
          annotation(0, 'Cmd R_REGISTER "STATUS"'),
          annotation(2, 'Reg RX_ADDR_P0 = "5544332211"'),
          annotation(1, 'TX payload = "ABC"'),
          annotation(1, 'TX payload = "\\x00"'),
          annotation(3, 'RX payload = "A"'),
          annotation(2, 'Payload width = 32'),
          annotation(1, 'ACK payload for pipe 3 = "5"'),
          annotation(0, 'Cmd FLUSH_TX'),
          annotation(0, 'Cmd NOP'),
          annotation(0, 'Cmd ACTIVATE'),
          annotation(4, 'wrong data for "ACTIVATE" command'),
          annotation(4, 'unknown command'),
          annotation(4, 'missing data bytes'),
          annotation(4, 'excess byte'),
          annotation(0, 'Cmd R_REGISTER "unknown register"'),
          annotation(4, 'unknown register'),
        ],
        annotationCount: counts.reduce((sum, count) => sum + count, 0),
        payloadBits: data.reduce((sum, item) => sum + item.mosi.length * 8, 0),
      };
    },
  };

  yield {
    name: 'boundary-xn297-register',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 31n,
    channels: { clk: 0, miso: 2, mosi: 5, cs: 6 },
    options: { chip: 'xn297' },
    chunkSamples: [3, 17, 257],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [transaction([0x19, 0, 0, 0, 0, 0], [0x01, 0x02, 0x03, 0x04, 0x05])];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(0, 'Cmd R_REGISTER "DEMOD_CAL"'),
          annotation(2, 'Reg DEMOD_CAL = "0504030201"'),
        ],
        annotationCount: 3,
        payloadBits: 48,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerTransaction = 48,
    total = Math.ceil(required / bitsPerTransaction),
    perBlock = 4096,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-address-register-writes',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: { chip: 'nrf24l01' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(perBlock, total - block * perBlock),
          data: Nrf24l01Frame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const address = Array.from({ length: 5 }, () => random() & 0xff);
          data.push(transaction([0x2a, ...address]));
          if (index === 0 || index === count - 1) {
            expectedAnnotations.push(
              annotation(2, 'Reg STATUS = "0E"'),
              annotation(0, `Cmd W_REGISTER: RX_ADDR_P0 = "${[...address].reverse().map(hex).join('')}"`),
            );
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
