import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface AdnsTransaction {
  readonly mosi: readonly number[];
  readonly miso?: readonly number[];
  readonly pauseAfter?: boolean;
}

export interface AdnsCase extends RoundtripCase<AdnsTransaction> {}

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
const SUMMARY: ExpectedFrame = { protoId: 'adns5020', kind: 'summary' };

const REGISTERS: Readonly<Record<number, string>> = {
  0x00: 'Product_ID',
  0x01: 'Revision_ID',
  0x02: 'Motion',
  0x03: 'Delta_X',
  0x04: 'Delta_Y',
  0x05: 'SQUAL',
  0x06: 'Shutter_Upper',
  0x07: 'Shutter_Lower',
  0x08: 'Maximum_Pixel',
  0x09: 'Pixel_Sum',
  0x0a: 'Minimum_Pixel',
  0x0b: 'Pixel_Grab',
  0x0d: 'Mouse_Control',
  0x3a: 'Chip_Reset',
  0x3f: 'Inv_Rev_ID',
  0x63: 'Motion_Burst',
};

function annotation(command: number, argument: number): ExpectedFrame {
  const write = (command & 0x80) !== 0,
    register = command & 0x7f,
    name = register > 0x63 ? 'Unknown' : (REGISTERS[register] ?? `Reserved 0x${register.toString(16)}`),
    text = write ? `${name}: 0x${argument.toString(16)}` : `${name}: ${argument.toString(10)}`;
  return { classIndex: write ? 1 : 0, texts: [text] };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x41444e53,
}: GenerationOptions = {}): Iterable<AdnsCase> {
  yield {
    name: 'boundary-register-kinds-and-cs',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data: AdnsTransaction[] = [
        { mosi: [0x00, 0x2f] },
        { mosi: [0xba, 0x5a] },
        { mosi: [0x0c, 0x00] },
        { mosi: [0x7f, 0x00] },
        { mosi: [0x63, 0x01] },
        { mosi: [0x00], pauseAfter: true },
        { mosi: [0x3f, 0x00] },
      ];
      const expectedAnnotations: ExpectedFrame[] = [
        { classIndex: 0, texts: ['Product_ID: 47'] },
        { classIndex: 1, texts: ['Chip_Reset: 0x5a'] },
        { classIndex: 0, texts: ['Reserved 0xc: 0'] },
        { classIndex: 0, texts: ['Unknown: 0'] },
        { classIndex: 0, texts: ['Motion_Burst: 1'] },
        { classIndex: 2, texts: ['Misplaced CS#!'] },
        { classIndex: 0, texts: ['Inv_Rev_ID: 0'] },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.reduce((sum, item) => sum + item.mosi.length * 8, 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    total = Math.ceil(required / 16),
    perBlock = 8192,
    blocks = Math.ceil(total / perBlock);
  yield {
    name: 'seeded-long-register-stream',
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
        const data: AdnsTransaction[] = [];
        for (let index = block * perBlock; index < Math.min(total, (block + 1) * perBlock); index++)
          data.push({ mosi: [random() & 0xff, random() & 0xff] });
        const first = data[0]!,
          expectedAnnotations = [annotation(first.mosi[0]!, first.mosi[1]!)];
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
