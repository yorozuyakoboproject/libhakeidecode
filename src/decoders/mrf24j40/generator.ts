import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Mrf24j40Frame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Mrf24j40Case extends RoundtripCase<Mrf24j40Frame> {}

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
const SUMMARY: ExpectedFrame = { protoId: 'mrf24j40', kind: 'summary' };

function shortCommand(register: number, write: boolean, value = 0): Mrf24j40Frame {
  const mosi = [(register << 1) | (write ? 1 : 0), value];
  return { mosi, miso: write ? [0, 0] : [0, value] };
}

function longCommand(register: number, write: boolean, value: number): Mrf24j40Frame {
  const high = 0x80 | ((register >> 3) & 0x7f),
    low = ((register & 7) << 5) | (write ? 0x10 : 0);
  return {
    mosi: [high, low, write ? value : 0],
    miso: [0, 0, write ? 0 : value],
  };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d524632,
}: GenerationOptions = {}): Iterable<Mrf24j40Case> {
  yield {
    name: 'boundary-short-long-frames-retries-and-cca',
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
          longCommand(0x000, true, 0x11),
          longCommand(0x001, true, 0x22),
          shortCommand(0x1b, true, 1),
          longCommand(0x200, true, 0x33),
          longCommand(0x2c0, true, 0x44),
          longCommand(0x300, true, 0x55),
          longCommand(0x301, true, 0x66),
          shortCommand(0x0d, true, 1),
          shortCommand(0x24, false, 0x60),
          shortCommand(0x24, false, 0x80),
          shortCommand(0x24, false, 0xc1),
          shortCommand(0x00, false, 0x0f),
          shortCommand(0x01, true, 0x34),
          shortCommand(0x0e, false, 0xaa),
          longCommand(0x201, false, 0x77),
          longCommand(0x280, false, 0x88),
          longCommand(0x2c0, false, 0x99),
          longCommand(0x302, false, 0xbb),
          shortCommand(0x0d, true, 1),
          { mosi: [0x48], miso: [0] },
        ],
        counts = [1, 1, 2, 1, 1, 1, 1, 2, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 2, 1];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(3, 'TX:0x0: 0x11'),
          annotation(3, 'TX:0x1: 0x22'),
          annotation(5, 'TX frame: 11 22'),
          annotation(1, 'TXNCON: 0x1'),
          annotation(3, 'RFCON0: 0x33'),
          annotation(3, 'Reserved:0x2c0: 0x44'),
          annotation(3, 'RX:0x300: 0x55'),
          annotation(3, 'RX:0x301: 0x66'),
          annotation(6, 'RX frame: 55 66'),
          annotation(0, 'TXSTAT: 0x60'),
          annotation(7, 'TX retries: 1'),
          annotation(11, 'CCAFAIL (channel busy)', 'CCAFAIL'),
          annotation(8, 'TX retries: 2'),
          annotation(10, 'TX fail (>= 4 retries)', 'TX fail'),
          annotation(0, 'RXMCR: 0xf'),
          annotation(1, 'PANIDL: 0x34'),
          annotation(0, 'Reserved: 0xaa'),
          annotation(2, 'RFCON1: 0x77'),
          annotation(2, 'Security keys:0x280: 0x88'),
          annotation(2, 'Reserved:0x2c0: 0x99'),
          annotation(2, 'RX:0x302: 0xbb'),
          annotation(6, 'RX frame: BB'),
          annotation(4, 'Misplaced CS!'),
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
    name: 'seeded-long-short-register-writes',
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
          data: Mrf24j40Frame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const value = random() & 0xff;
          data.push(shortCommand(0x01, true, value));
          if (index === 0 || index === count - 1)
            expectedAnnotations.push(annotation(1, `PANIDL: 0x${value.toString(16)}`));
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length,
          payloadBits: data.length * 16,
        };
      }
    },
  };
}
