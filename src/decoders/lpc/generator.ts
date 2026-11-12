import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface LpcStep {
  readonly frame: 0 | 1;
  readonly lad: number;
}

export interface LpcCase extends RoundtripCase<LpcStep> {}

const CHANNELS = { lframe: 0, lclk: 1, lad0: 2, lad1: 3, lad2: 4, lad3: 5 } as const;
const SAMPLE_RATE = 2_000_000;

function nibbles(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (value >>> (4 * (count - index - 1))) & 0xf);
}

function transaction(cycleType: number, address: number, data: number): LpcStep[] {
  const addressNibbles = cycleType < 0b0100 || cycleType > 0b0110 ? 0 : 8;
  return [
    { frame: 0, lad: 0 },
    { frame: 1, lad: 0 },
    { frame: 1, lad: cycleType },
    ...nibbles(address, addressNibbles).map((lad) => ({ frame: 1 as const, lad })),
    { frame: 1, lad: 0xf },
    { frame: 1, lad: 0xf },
    { frame: 1, lad: 0 },
    { frame: 1, lad: data & 0xf },
    { frame: 1, lad: (data >>> 4) & 0xf },
    { frame: 1, lad: 0xf },
    { frame: 1, lad: 0xf },
  ];
}

function ioTransaction(direction: 'read' | 'write', address: number, data: number): LpcStep[] {
  return [
    { frame: 0, lad: 0 },
    { frame: 1, lad: 0 },
    { frame: 1, lad: direction === 'read' ? 0 : 2 },
    ...nibbles(address, 4).map((lad) => ({ frame: 1 as const, lad })),
    { frame: 1, lad: 0xf },
    { frame: 1, lad: 0xf },
    { frame: 1, lad: 0 },
    { frame: 1, lad: data & 0xf },
    { frame: 1, lad: (data >>> 4) & 0xf },
    { frame: 1, lad: 0xf },
    { frame: 1, lad: 0xf },
  ];
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

function prefixAnnotations(cycleText: string, addressText: string): ExpectedFrame[] {
  return [
    annotation(1, 'Start of cycle for a target', 'START', 'St', 'S'),
    annotation(2, `Cycle type: ${cycleText}`),
    annotation(3, `Address: 0x${addressText}`),
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4c5043,
}: GenerationOptions = {}): Iterable<LpcCase> {
  const boundaryIo = ioTransaction('read', 0x1234, 0x5a);
  const boundaryMemory = transaction(0b0110, 0x89abcdef, 0xc3);
  yield {
    name: 'io-and-memory-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = [...boundaryIo, ...boundaryMemory];
      yield {
        data,
        expected: [{ protoId: 'lpc', kind: 'summary' }],
        expectedAnnotations: [
          ...prefixAnnotations('I/O read', '1234'),
          annotation(4, 'TAR, cycle 0: 1111'),
          annotation(4, 'TAR, cycle 1: 1111'),
          annotation(5, 'SYNC, cycle 0: 0000'),
          annotation(6, 'DATA: 0x5a'),
          annotation(7, 'TAR, cycle 0: 1111'),
          annotation(7, 'TAR, cycle 1: 1111'),
          ...prefixAnnotations('Memory write', '89abcdef'),
          annotation(4, 'TAR, cycle 0: 1111'),
          annotation(4, 'TAR, cycle 1: 1111'),
          annotation(5, 'SYNC, cycle 0: 0000'),
          annotation(6, 'DATA: 0xc3'),
          annotation(7, 'TAR, cycle 0: 1111'),
          annotation(7, 'TAR, cycle 1: 1111'),
        ],
        annotationCount: 18,
        payloadBits: data.length * 4,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const transactionsPerBlock = 3_641;
  const blocks = 4;
  yield {
    name: 'seeded-long-memory-write',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: LpcStep[] = [];
        let firstAddress = 0;
        let firstData = 0;
        for (let index = 0; index < transactionsPerBlock; index++) {
          const address = random();
          const value = random() & 0xff;
          if (!index) {
            firstAddress = address;
            firstData = value;
          }
          data.push(...transaction(0b0110, address, value));
        }
        yield {
          data,
          expected: block === 0 ? [{ protoId: 'lpc', kind: 'summary' }] : [],
          expectedAnnotations: [
            ...prefixAnnotations('Memory write', firstAddress.toString(16).padStart(8, '0')),
            annotation(6, `DATA: 0x${firstData.toString(16).padStart(2, '0')}`),
          ],
          annotationCount: transactionsPerBlock * 9,
          payloadBits: transactionsPerBlock * 18 * 4,
        };
      }
    },
  };
}
