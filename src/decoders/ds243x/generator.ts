import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { bitsFromBigInt, bitsFromBytes } from '../onewire_link/generator.js';
import type { OnewireOperation } from '../onewire_link/generator.js';

export interface Ds243xCase extends RoundtripCase<OnewireOperation> {}

const CHAIN = [
  { decoder: 'onewire_link', options: { overdrive: 'yes' } },
  { decoder: 'onewire_network', options: {} },
] as const;
const SUMMARY: ExpectedFrame = { protoId: 'ds243x', kind: 'summary' };
const ROM = 0x1234567890abcd33n;

function crc16(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      if (((byte ^ crc) & 1) !== 0) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

function withCrc(bytes: readonly number[], crc: number): number[] {
  return [...bytes, crc & 0xff, (crc >>> 8) & 0xff];
}

function command(overdrive: boolean, bytes: readonly number[], rom = ROM): OnewireOperation[] {
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
}: GenerationOptions = {}): Iterable<Ds243xCase> {
  yield {
    name: 'boundary-command-family',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { owr: 6 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const writeScratchpad = withCrc([0x0f, 0x34, 0x12, 1, 2, 3, 4, 5, 6, 7, 8], 0),
        writeCrc = crc16(writeScratchpad.slice(0, 11));
      writeScratchpad[11] = writeCrc & 0xff;
      writeScratchpad[12] = writeCrc >>> 8;
      const readScratchpad = withCrc([0xaa, 0x78, 0x56, 0x01, 9, 10, 11, 12, 13, 14, 15, 16], 0),
        readCrc = crc16(readScratchpad.slice(0, 12));
      readScratchpad[12] = readCrc & 0xff;
      readScratchpad[13] = readCrc >>> 8;
      const authPage = [0xa5, 0x34, 0x12, ...Array.from({ length: 32 }, (_, index) => index), 0xff, 0, 0];
      authPage[36] = 0;
      authPage[37] = 0;
      const authCrc = crc16(authPage.slice(0, 36));
      authPage[36] = authCrc & 0xff;
      authPage[37] = authCrc >>> 8;
      for (let index = 0; index < 20; index++) authPage.push((index * 7) & 0xff);
      const macCrc = crc16(authPage.slice(38, 58));
      authPage.push(macCrc & 0xff, macCrc >>> 8, 0xaa);
      const data = [
          ...command(true, writeScratchpad),
          ...command(true, readScratchpad),
          ...command(true, [0x5a, 0x34, 0x12, 0x01, 0xaa]),
          ...command(true, [0x33, 0x34, 0x12, 0x55]),
          ...command(true, [0x55, 0x34, 0x12, 0x01, ...Array.from({ length: 20 }, (_, index) => index), 0xaa]),
          ...command(true, authPage),
          ...command(true, [0xf0, 0x34, 0x12, 0x00, 0xff]),
          ...command(true, [0x77]),
        ],
        expectedAnnotations: ExpectedFrame[] = [
          { classIndex: 0, texts: ['Reset/presence: true'] },
          {
            classIndex: 0,
            texts: [
              'ROM: 0x1234567890abcd33 (family code is 0x33, DS2432 detected)',
              'ROM: 0x1234567890abcd33 (DS2432)',
            ],
          },
          { classIndex: 0, texts: ['Function command: Write scratchpad (0x0f)'] },
          { classIndex: 0, texts: ['Target address: 0x1234'] },
          { classIndex: 0, texts: ['Data: 0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08'] },
          { classIndex: 0, texts: ['CRC: ok'] },
          { classIndex: 0, texts: ['Data status (E/S): 0x01'] },
          { classIndex: 0, texts: ['Padding: ok'] },
          { classIndex: 0, texts: ['Operation completed'] },
        ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: 48,
        payloadBits: data.reduce(
          (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
          0,
        ),
      };
    },
  };

  yield {
    name: 'unknown-family-and-command',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 31n,
    channels: { owr: 0 },
    options: {},
    chunkSamples: [7, 127, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = command(true, [0x77], 0x1234567890abcd55n);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          {
            classIndex: 0,
            texts: ['ROM: 0x1234567890abcd55 (family code 0x55 unknown)', 'ROM: 0x1234567890abcd55 ()'],
          },
          { classIndex: 0, texts: ['Unrecognized command: 0x77'] },
        ],
        annotationCount: 3,
        payloadBits: 8 + 64 + 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    transactionsPerBlock = 300,
    bitsPerTransaction = 8 + 64 + 8 + 16 + 8,
    blocks = Math.ceil(required / (transactionsPerBlock * bitsPerTransaction));
  yield {
    name: 'seeded-long-memory-read',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { owr: 2 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: OnewireOperation[] = [];
        for (let index = 0; index < transactionsPerBlock; index++) {
          const rom = (((BigInt(random()) << 32n) | BigInt(random())) & ~0xffn) | 0x33n;
          data.push(...command(true, [0xf0, random() & 0xff, random() & 0xff, random() & 0xff], rom));
        }
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 0, texts: ['Reset/presence: true'] },
            { classIndex: 0, texts: ['Function command: Read memory (0xf0)'] },
          ],
          annotationCount: transactionsPerBlock * 5,
          payloadBits: data.reduce(
            (count, operation) => count + (operation.kind === 'bits' ? operation.bits.length : 0),
            0,
          ),
        };
      }
    },
  };
}
