import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface I2COperation {
  readonly address: number;
  readonly addressBits: 7 | 10;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface EdidCase extends RoundtripCase<I2COperation> {}

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'unshifted' } }] as const;
const SUMMARY: ExpectedFrame = { protoId: 'edid', kind: 'summary' };
const DETAILED_TIMING = [
  0x64, 0x19, 0x80, 0x18, 0x71, 0x38, 0x2d, 0x40, 0x58, 0x2c, 0x45, 0x00, 0x09, 0x25, 0x21, 0x00, 0x00, 0x1a,
] as const;

function textDescriptor(tag: number, text: string): number[] {
  return [0, 0, 0, tag, 0, ...Array.from({ length: 13 }, (_, index) => text.charCodeAt(index) || 0x20)];
}

function withChecksum(bytes: number[]): number[] {
  bytes[127] = 0;
  bytes[127] = (256 - (bytes.slice(0, 127).reduce((sum, value) => sum + value, 0) % 256)) % 256;
  return bytes;
}

function baseEdid(serial: number, extensions = 0, vendor = 'DEL'): number[] {
  const bytes = new Array<number>(128).fill(0);
  const [first, second, third] = Array.from(vendor, (letter) => letter.charCodeAt(0) - 64);
  bytes.splice(0, 8, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00);
  bytes.splice(
    8,
    8,
    ((first! << 2) | (second! >>> 3)) & 0xff,
    ((second! << 5) | third!) & 0xff,
    0x34,
    0x12,
    serial & 0xff,
    (serial >>> 8) & 0xff,
    (serial >>> 16) & 0xff,
    (serial >>> 24) & 0xff,
  );
  bytes[16] = 10;
  bytes[17] = 35;
  bytes[18] = 1;
  bytes[19] = 3;
  bytes[20] = 0x80;
  bytes[21] = 52;
  bytes[22] = 32;
  bytes[23] = 120;
  bytes[24] = 0x0e;
  bytes.splice(38, 16, 0x81, 0xc0, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01);
  bytes.splice(54, 18, ...DETAILED_TIMING);
  bytes.splice(72, 18, ...textDescriptor(0xfc, 'CODEX PANEL'));
  bytes.splice(90, 18, ...textDescriptor(0xff, 'SN1234567890'));
  bytes.splice(108, 18, ...textDescriptor(0xfe, 'PRODUCTION EDID'));
  bytes[126] = extensions;
  return withChecksum(bytes);
}

function extensionBlock(): number[] {
  const bytes = new Array<number>(128).fill(0);
  bytes[0] = 0x02;
  bytes[1] = 0x03;
  bytes[2] = 0x08;
  bytes[3] = 0x00;
  bytes.splice(4, 4, 0x43, 0x04, 0x10, 0x84);
  return withChecksum(bytes);
}

function readEdid(data: readonly number[]): I2COperation[] {
  return [
    { address: 0x50, addressBits: 7, direction: 'write', data: [0x00], stop: false },
    {
      address: 0x50,
      addressBits: 7,
      direction: 'read',
      data,
      repeatedStart: true,
      dataAcks: data.map((_, index) => index < data.length - 1),
    },
  ];
}

function bits(operations: readonly I2COperation[]): number {
  return operations.reduce((sum, operation) => sum + 9 * (1 + operation.data.length), 0);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x45444944,
}: GenerationOptions = {}): Iterable<EdidCase> {
  yield {
    name: 'complete-base-block',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: { scl: 1, sda: 4 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = readEdid(baseEdid(0x12345678));
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 1, texts: ['Offset: 0', 'O: 0', '0'] },
          { classIndex: 1, texts: ['EDID'] },
          { classIndex: 1, texts: ['Header'] },
          { classIndex: 0, texts: ['Header pattern'] },
          { classIndex: 0, texts: ['DEL (Dell Inc.)'] },
          { classIndex: 0, texts: ['Product 0x1234'] },
          { classIndex: 0, texts: ['Manufactured week 10, 2025', 'week 10, 2025'] },
          { classIndex: 0, texts: ['Version 1'] },
          { classIndex: 0, texts: ['Revision 3'] },
          { classIndex: 1, texts: ['Preferred timing descriptor'] },
          { classIndex: 1, texts: ['Monitor name'] },
          { classIndex: 0, texts: ['CODEX PANEL'] },
          { classIndex: 0, texts: ['Extensions present: 0'] },
        ],
        annotationCount: 56,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'cea-extension-block',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { scl: 2, sda: 5 },
    options: {},
    chunkSamples: [7, 127, 2047],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations: I2COperation[] = [
        ...readEdid(baseEdid(0x12345678, 1)),
        { address: 0x50, addressBits: 7, direction: 'write' as const, data: [0x80], stop: false },
        {
          address: 0x50,
          addressBits: 7,
          direction: 'read' as const,
          data: extensionBlock(),
          repeatedStart: true,
          dataAcks: extensionBlock().map((_, index) => index < 127),
        },
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 1, texts: ['Extension: 1', 'X: 1', '1'] },
          { classIndex: 1, texts: ['Extensions Tag', 'Tag'] },
          { classIndex: 1, texts: ['Version'] },
          { classIndex: 1, texts: ['DTD offset'] },
          { classIndex: 1, texts: ['Format support | DTD count'] },
          { classIndex: 1, texts: ['Data block collection'] },
          { classIndex: 0, texts: ['2: Video Data Block', 'Video'] },
          { classIndex: 0, texts: ['VIC: 4, 16, 4 (Native)'] },
        ],
        annotationCount: 70,
        payloadBits: bits(operations),
      };
    },
  };

  yield {
    name: 'pnp-vendor-lookup',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 31n,
    channels: { scl: 4, sda: 6 },
    options: {},
    chunkSamples: [3, 67],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = readEdid(baseEdid(0x12345678, 0, 'ENC'));
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [{ classIndex: 0, texts: ['ENC (Eizo Nanao Corporation)'] }],
        payloadBits: bits(operations),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    cyclesPerBlock = 75,
    bitsPerCycle = bits(readEdid(baseEdid(0))),
    blocks = Math.ceil(required / (cyclesPerBlock * bitsPerCycle));
  yield {
    name: 'seeded-long-edid-reads',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 0, sda: 3 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const operations: I2COperation[] = [];
        for (let cycle = 0; cycle < cyclesPerBlock; cycle++) operations.push(...readEdid(baseEdid(random())));
        yield {
          data: operations,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 1, texts: ['Offset: 0', 'O: 0', '0'] },
            { classIndex: 1, texts: ['EDID'] },
            { classIndex: 1, texts: ['Header'] },
          ],
          annotationCount: cyclesPerBlock * 56,
          payloadBits: cyclesPerBlock * bitsPerCycle,
        };
      }
    },
  };
}
