import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { bitsFromBigInt, bitsFromBytes } from '../onewire_link/generator.js';
import type { OnewireOperation } from '../onewire_link/generator.js';

export interface Ds28ea00Case extends RoundtripCase<OnewireOperation> {}

const CHAIN = [
  { decoder: 'onewire_link', options: { overdrive: 'yes' } },
  { decoder: 'onewire_network', options: {} },
] as const;
const SUMMARY: ExpectedFrame = { protoId: 'ds28ea00', kind: 'summary' };

function command(overdrive: boolean, bytes: readonly number[], rom = 0x1234567890abcd28n): OnewireOperation[] {
  return [
    { kind: 'reset', presence: true, overdrive },
    { kind: 'bits', bits: bitsFromBytes([0x55]), overdrive },
    { kind: 'bits', bits: bitsFromBigInt(rom, 64), overdrive },
    { kind: 'bits', bits: bitsFromBytes(bytes), overdrive },
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x44533238,
}: GenerationOptions = {}): Iterable<Ds28ea00Case> {
  yield {
    name: 'boundary-command-states',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { owr: 7 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [
          ...command(true, [0xbe, 0x12, 0x34]),
          ...command(true, [0x44, 0x00]),
          ...command(true, [0xa5, 0x5a]),
          ...command(true, [0x99]),
          ...command(true, [0xff, 0x44, 0x01]),
        ],
        expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 0, texts: ['Reset/presence: true'] },
          { classIndex: 0, texts: ['ROM: 0x1234567890abcd28'] },
          { classIndex: 0, texts: ["Function command: 0xbe 'Read scratchpad'"] },
          { classIndex: 0, texts: ['Scratchpad data: 0x12'] },
          { classIndex: 0, texts: ["Function command: 0x44 'Convert temperature'"] },
          { classIndex: 0, texts: ['Temperature conversion status: 0x00'] },
          { classIndex: 0, texts: ["Function command: 0xa5 'PIO access write'"] },
          { classIndex: 0, texts: ["TODO 'PIO ACCESS WRITE': 0x5a"] },
          { classIndex: 0, texts: ['Unrecognized command: 0xff'] },
          { classIndex: 0, texts: ["Function command: 0x44 'Convert temperature'"] },
        ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 21,
        payloadBits: data.reduce(
          (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
          0,
        ),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    transactionsPerBlock = 400,
    bitsPerTransaction = 8 + 64 + 8 + 8,
    blocks = Math.ceil(required / (transactionsPerBlock * bitsPerTransaction));
  yield {
    name: 'seeded-long-temperature-stream',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { owr: 4 },
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
          data.push(...command(true, [0x44, random() & 0xff], rom));
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 0, texts: ['Reset/presence: true'] },
            { classIndex: 0, texts: ["Function command: 0x44 'Convert temperature'"] },
          ],
          annotationCount: transactionsPerBlock * 4,
          payloadBits: data.reduce(
            (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
            0,
          ),
        };
      }
    },
  };
}
