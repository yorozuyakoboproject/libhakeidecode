import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface McpOperation {
  readonly address: number;
  readonly addressBits?: 7 | 10;
  readonly direction: 'read' | 'write';
  readonly data: readonly number[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface McpCase extends RoundtripCase<McpOperation> {}

const SUMMARY: ExpectedFrame = { protoId: 'mcp230xx', kind: 'summary' };

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d4350,
}: GenerationOptions = {}): Iterable<McpCase> {
  yield {
    name: 'mcp23008-bank0-read-write',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 17n,
    channels: { scl: 2, sda: 5 },
    options: { type: 'MCP23008' },
    chain: [{ decoder: 'i2c', options: { address_format: 'unshifted' } }],
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: McpOperation[] = [
        { address: 0x20, direction: 'write', data: [0x00, 0xff, 0x00], stop: true },
        { address: 0x20, direction: 'write', data: [0x09], stop: false },
        { address: 0x20, direction: 'read', data: [0x5a, 0xa5, 0x00], repeatedStart: true, stop: true },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(1, 'Write IODIR: FF', 'WFF'),
          annotation(1, 'Write IPOL: 00', 'W00'),
          annotation(0, 'Read GPIO: 5A', 'R5A'),
          annotation(0, 'Read OLAT: A5', 'RA5'),
          annotation(2, 'Error: Register 11 not accessible'),
        ],
        annotationCount: 5,
        payloadBits: 90,
      };
    },
  };

  yield {
    name: 'mcp23017-bank-switch-and-address-warning',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 31n,
    channels: { scl: 0, sda: 1 },
    options: { type: 'MCP23017' },
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [3, 31, 511],
    minimumPayloadBits: 0,
    *generate() {
      const data: McpOperation[] = [
        { address: 0x20, direction: 'write', data: [0x0a, 0x80], stop: true },
        { address: 0x20, direction: 'write', data: [0x0b, 0x55], stop: true },
        { address: 0x30, direction: 'write', data: [0x00, 0x01], stop: true },
      ];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [
          annotation(1, 'Write IOCON: 80', 'W80'),
          annotation(1, 'Write IODIRB: 55', 'W55'),
          annotation(2, 'Address 30 not MCP230XX compatible'),
          annotation(1, 'Write IODIRA: 01', 'W01'),
        ],
        annotationCount: 4,
        payloadBits: 81,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const perBlock = Math.ceil(required / 4);
  yield {
    name: 'seeded-long-bank0-writes',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 0, sda: 1 },
    options: { type: 'MCP23017' },
    chain: [{ decoder: 'i2c', options: {} }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < 4; block++) {
        const value = random() & 0xff;
        const data: McpOperation[] = [{ address: 0x20, direction: 'write', data: [0x00, value], stop: true }];
        let payloadBits = 27;
        const fillers = Math.ceil(Math.max(0, perBlock - payloadBits) / 18);
        for (let index = 0; index < fillers; index++)
          data.push({ address: 0x20, direction: 'write', data: [0x00], stop: true });
        payloadBits += fillers * 18;
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [annotation(1, `Write IODIRA: ${hex(value)}`, `W${hex(value)}`)],
          annotationCount: 1,
          payloadBits,
        };
      }
    },
  };
}
