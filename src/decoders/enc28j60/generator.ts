import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Enc28j60Frame {
  readonly mosi: readonly number[];
  readonly miso: readonly number[];
}

export interface Enc28j60Case extends RoundtripCase<Enc28j60Frame> {}

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
const SUMMARY: ExpectedFrame = { protoId: 'enc28j60', kind: 'summary' };

function frame(mosi: readonly number[], miso: readonly number[] = []): Enc28j60Frame {
  return { mosi, miso: [0, ...miso] };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x454e4332,
}: GenerationOptions = {}): Iterable<Enc28j60Case> {
  yield {
    name: 'boundary-banks-mac-errors-and-memory',
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
          frame([0x5f, 0x00]),
          frame([0x40, 0x12]),
          frame([0x00, 0x00], [0x34]),
          frame([0x00, 0x00, 0x00], [0x00, 0x56]),
          frame([0x5f, 0x02]),
          frame([0x00, 0x00, 0x00], [0x00, 0x00, 0xaa]),
          frame([0x00, 0x00]),
          frame([0x9f, 0x01]),
          frame([0xbf, 0x03]),
          frame([0x3a, 0x00, 0x00], [0x11, 0x22]),
          frame([0x7a, 0x00, 0x00], [0x00, 0x00]),
          frame([0xe0]),
          frame([0x3b, 0x00]),
          frame([0xc0, 0x00]),
          frame([0x00]),
          frame([0x00, 0x00], [0x00]),
        ],
        counts = [4, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 1, 1, 1, 2, 3];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(2, 'Write Control Register', 'WCR'),
          annotation(8, 'Reg Bank ? Addr 0x1F', '?:1F'),
          annotation(9, 'Warning: Register bank not known yet.', 'Warning'),
          annotation(7, 'Data 0x00', '00'),
          annotation(2, 'Write Control Register', 'WCR'),
          annotation(8, 'Reg ERDPTL', 'ERDPTL'),
          annotation(7, 'Data 0x12', '12'),
          annotation(0, 'Read Control Register', 'RCR'),
          annotation(8, 'Reg ERDPTL', 'ERDPTL'),
          annotation(7, 'Data 0x34', '34'),
          annotation(0, 'Read Control Register', 'RCR'),
          annotation(8, 'Reg ERDPTL', 'ERDPTL'),
          annotation(9, 'Warning: Attempting to read a non-MAC/MII register using the dummy byte.', 'Warning'),
          annotation(2, 'Write Control Register', 'WCR'),
          annotation(8, 'Reg ECON1', 'ECON1'),
          annotation(7, 'Data 0x02', '02'),
          annotation(0, 'Read Control Register', 'RCR'),
          annotation(9, 'Warning: Invalid command length.', 'Warning'),
          annotation(0, 'Read Control Register', 'RCR'),
          annotation(8, 'Reg MACON1', 'MACON1'),
          annotation(9, 'Warning: Attempting to read a MAC/MII register without using the dummy byte.', 'Warning'),
          annotation(4, 'Bit Field Set', 'BFS'),
          annotation(8, 'Reg ECON1', 'ECON1'),
          annotation(7, 'Data 0b00000001', '00000001'),
          annotation(5, 'Bit Field Clear', 'BFC'),
          annotation(8, 'Reg ECON1', 'ECON1'),
          annotation(7, 'Data 0b00000011', '00000011'),
          annotation(1, 'Read Buffer Memory: Length 2', 'RBM'),
          annotation(7, 'Data 0x11', '11'),
          annotation(7, 'Data 0x22', '22'),
          annotation(3, 'Write Buffer Memory: Length 2', 'WBM'),
          annotation(7, 'Data 0x00', '00'),
          annotation(7, 'Data 0x00', '00'),
          annotation(6, 'System Reset Command', 'SRC'),
          annotation(9, 'Warning: Invalid header byte.', 'Warning'),
          annotation(9, 'Warning: Unknown opcode.', 'Warning'),
          annotation(0, 'Read Control Register', 'RCR'),
          annotation(9, 'Warning: Invalid command length.', 'Warning'),
          annotation(0, 'Read Control Register', 'RCR'),
          annotation(8, 'Reg ERDPTL', 'ERDPTL'),
          annotation(7, 'Data 0x00', '00'),
        ],
        annotationCount: counts.reduce((sum, count) => sum + count, 0),
        payloadBits: data.reduce((sum, item) => sum + item.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    perBlock = 4096,
    blockBits = 8 + perBlock * 16,
    blocks = Math.ceil(required / blockBits);
  yield {
    name: 'seeded-long-control-register-writes',
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
        const data: Enc28j60Frame[] = [frame([0xe0])],
          expectedAnnotations: ExpectedFrame[] = [annotation(6, 'System Reset Command', 'SRC')];
        for (let index = 0; index < perBlock; index++) {
          const value = random() & 0xff;
          data.push(frame([0x40, value]));
          if (index === 0 || index === perBlock - 1) {
            expectedAnnotations.push(
              annotation(2, 'Write Control Register', 'WCR'),
              annotation(8, 'Reg ERDPTL', 'ERDPTL'),
              annotation(
                7,
                `Data 0x${value.toString(16).toUpperCase().padStart(2, '0')}`,
                value.toString(16).toUpperCase().padStart(2, '0'),
              ),
            );
          }
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: 1 + perBlock * 3,
          payloadBits: blockBits,
        };
      }
    },
  };
}
