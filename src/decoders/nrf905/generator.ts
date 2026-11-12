import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Nrf905Frame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Nrf905Case extends RoundtripCase<Nrf905Frame> {}

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
const SUMMARY: ExpectedFrame = { protoId: 'nrf905', kind: 'summary' };
const STATUS = 0x0e;

function transaction(mosi: readonly number[], response: readonly number[] = []): Nrf905Frame {
  return { mosi, miso: [STATUS, ...response] };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

const COMMAND_STATUS: readonly ExpectedFrame[] = [
  annotation(0, 'CMD: W_CONFIG (WC)'),
  annotation(2, 'STAT = AM = 0 | DR = 0'),
];

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4e524639,
}: GenerationOptions = {}): Iterable<Nrf905Case> {
  yield {
    name: 'boundary-config-address-payload-and-channel',
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
          transaction([0x00, 0x2a, 0x01, 0x22, 0x20, 0x20, 0x11, 0x12, 0x13, 0x14, 0x65]),
          transaction(
            [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0x55, 0x00, 0x22, 0x20, 0x20, 0x9e, 0x01, 0x02, 0x03, 0x04],
          ),
          transaction([0x20, 0x41, 0x42]),
          transaction([0x21, 0, 0], [0x41, 0x42]),
          transaction([0x22, 0x11, 0x22, 0x33, 0x44]),
          transaction([0x23, 0, 0, 0, 0], [0x11, 0x22, 0x33, 0x44]),
          transaction([0x24, 0, 0], [0x41, 0x42]),
          transaction([0x81, 0x23]),
          transaction([0x30]),
          transaction([0x0a]),
          transaction([0x18, 0, 0, 0], [0x01, 0x02, 0x03]),
          transaction([0x05, 0x2a, 0x01, 0x22, 0x20, 0x20, 0x11, 0x12, 0x13, 0x14, 0x65]),
        ],
        counts = [12, 12, 3, 3, 3, 3, 3, 3, 2, 2, 4, 7];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          ...COMMAND_STATUS,
          annotation(1, 'CFG_REG[0x0] -> CH_NO = 42'),
          annotation(2, 'STAT = AM = 0 | DR = 0'),
          annotation(3, 'Write TX payload.: 41 42 '),
          annotation(5, 'Read TX payload: 41 42 '),
          annotation(1, 'Write TX addr: 11 22 33 44 '),
          annotation(5, 'Read TX addr: 11 22 33 44 '),
          annotation(4, 'Read RX payload: 41 42 '),
          annotation(0, 'CMD: CHANNEL_CONFIG (CC)'),
          annotation(2, 'STAT = AM = 0 | DR = 0'),
          annotation(1, 'PA_PWR = 0 (-10 dBm) | HFREQ_PLL = 0 (433 MHz)| CHN = 291'),
          annotation(0, ''),
          annotation(2, 'STAT = AM = 0 | DR = 0'),
          annotation(0, 'CMD: R_CONFIG (RC)'),
          annotation(2, 'CFG_REG[0x8] -> RX_ADDR_3 = 1'),
          annotation(
            2,
            'CFG_REG[0x9] -> CRC_MODE = 0 (8 CRC check bit) | CRC_EN = 0 (Disabled) | XOR = 0 (4 MHz) | UP_CLK_EN = 0 (No external clock signal avail.) | UP_CLK_FREQ = 2 (1 MHz)',
          ),
          annotation(0, 'CMD: W_CONFIG (WC)'),
          annotation(1, 'CFG_REG[0x5] -> RX_ADDR_0 = 42'),
        ],
        annotationCount: counts.reduce((sum, count) => sum + count, 0),
        payloadBits: data.reduce((sum, item) => sum + item.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bitsPerTransaction = 88,
    total = Math.ceil(required / bitsPerTransaction),
    perBlock = 4096,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-configuration-reads',
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
          data: Nrf905Frame[] = [],
          expectedAnnotations: ExpectedFrame[] = [
            annotation(0, 'CMD: R_CONFIG (RC)'),
            annotation(2, 'STAT = AM = 0 | DR = 0'),
          ];
        for (let index = 0; index < count; index++) {
          const response = Array.from({ length: 10 }, () => random() & 0xff);
          data.push(transaction([0x10, ...Array(10).fill(0)], response));
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length * 12,
          payloadBits: data.length * bitsPerTransaction,
        };
      }
    },
  };
}
