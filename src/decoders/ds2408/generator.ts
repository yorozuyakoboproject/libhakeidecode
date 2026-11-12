import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { bitsFromBigInt, bitsFromBytes } from '../onewire_link/generator.js';
import type { OnewireOperation } from '../onewire_link/generator.js';

export interface Ds2408Case extends RoundtripCase<OnewireOperation> {}

const CHAIN = [
  { decoder: 'onewire_link', options: { overdrive: 'yes' } },
  { decoder: 'onewire_network', options: {} },
] as const;
const SUMMARY: ExpectedFrame = { protoId: 'ds2408', kind: 'summary' };

function command(overdrive: boolean, bytes: readonly number[], rom = 0x1234567890abcdefn): OnewireOperation[] {
  return [
    { kind: 'reset', presence: true, overdrive },
    { kind: 'bits', bits: bitsFromBytes([0x55]), overdrive },
    { kind: 'bits', bits: bitsFromBigInt(rom, 64), overdrive },
    { kind: 'bits', bits: bitsFromBytes(bytes), overdrive },
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x44533234,
}: GenerationOptions = {}): Iterable<Ds2408Case> {
  yield {
    name: 'boundary-command-family',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { owr: 1 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
          ...command(true, [0xf0, 0x34, 0x12, 0xaa, 0x55]),
          ...command(true, [0xf5, 0x7e, 0x81]),
          ...command(true, [0x5a, 0x12, 0xed, 0xaa]),
          ...command(true, [0xcc, 0x34, 0x12, 0x01, 0x02]),
          ...command(true, [0xc3, 0x00, 0xaa]),
          ...command(true, [0x3c]),
          ...command(true, [0xff, 0x00]),
        ],
        expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 0, texts: ['Reset/presence: true'] },
          { classIndex: 0, texts: ['ROM: 0x1234567890abcdef (family code 0xef)'] },
          { classIndex: 0, texts: ['Read PIO Registers (0xf0)'] },
          { classIndex: 0, texts: ['Target address: 0x1234'] },
          { classIndex: 0, texts: ['Data: 0xaa'] },
          { classIndex: 0, texts: ['Data: 0x55'] },
          { classIndex: 0, texts: ['PIO sample: 0x81'] },
          { classIndex: 0, texts: ['Success'] },
          { classIndex: 0, texts: ['Unrecognized command: 0xff'] },
        ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 31,
        payloadBits: data.reduce(
          (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
          0,
        ),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    transactionsPerBlock = 300,
    bitsPerTransaction = 8 + 64 + 8 + 16 + 16,
    bitsPerBlock = transactionsPerBlock * bitsPerTransaction,
    blocks = Math.ceil(required / bitsPerBlock);
  yield {
    name: 'seeded-long-pio-read',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { owr: 6 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: OnewireOperation[] = [];
        for (let index = 0; index < transactionsPerBlock; index++) {
          const rom = (BigInt(random()) << 32n) | BigInt(random());
          data.push(...command(true, [0xf0, random() & 0xff, random() & 0xff, random() & 0xff, random() & 0xff], rom));
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 0, texts: ['Reset/presence: true'] },
            { classIndex: 0, texts: ['Read PIO Registers (0xf0)'] },
          ],
          annotationCount: transactionsPerBlock * 6,
          payloadBits: data.reduce(
            (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
            0,
          ),
        };
      }
    },
  };
}
