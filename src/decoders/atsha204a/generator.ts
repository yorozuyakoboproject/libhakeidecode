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

export interface Atsha204aCase extends RoundtripCase<I2COperation> {}

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'unshifted' } }] as const;
const SUMMARY: ExpectedFrame = { protoId: 'atsha204a', kind: 'summary' };

function write(address: number, data: readonly number[], options: Partial<I2COperation> = {}): I2COperation {
  return { address, addressBits: 7, direction: 'write', data, ...options };
}

function read(address: number, data: readonly number[], options: Partial<I2COperation> = {}): I2COperation {
  return { address, addressBits: 7, direction: 'read', data, ...options };
}

function command(opcode: number, param1: number, param2: number, data: readonly number[], crc: number): number[] {
  const body = [opcode, param1, param2 & 0xff, (param2 >>> 8) & 0xff, ...data, crc & 0xff, (crc >>> 8) & 0xff];
  return [0x03, body.length + 1, ...body];
}

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x41545348,
}: GenerationOptions = {}): Iterable<Atsha204aCase> {
  const commandBytes = command(0x12, 0x02, 0x1234, [0x00, 0x55, 0xaa, 0xff], 0);
  yield {
    name: 'command-write-and-status-read',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_000n,
    channels: { scl: 3, sda: 6 },
    options: {},
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        write(0x60, commandBytes),
        read(0x60, [0x04, 0x00, 0x34, 0x12], { dataAcks: [true, true, true, false] }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Word addr: COMMAND'] },
          { classIndex: 1, texts: ['Count: 11'] },
          { classIndex: 2, texts: ['Opcode: Write'] },
          { classIndex: 3, texts: ['Zone: DATA, Encrypted: No, Length: 4 bytes'] },
          { classIndex: 4, texts: ['Address: 12 34'] },
          { classIndex: 5, texts: ['Value: 00 55 aa ff'] },
          { classIndex: 6, texts: ['CRC: 00 00'] },
          { classIndex: 1, texts: ['Count: 4'] },
          { classIndex: 5, texts: ['Data: 00'] },
          { classIndex: 6, texts: ['CRC: 34 12'] },
          { classIndex: 7, texts: ['Status: Command success'] },
        ],
        annotationCount: 11,
        payloadBits: operations.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  yield {
    name: 'reset-response',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 17n,
    channels: { scl: 0, sda: 1 },
    options: {},
    chunkSamples: [31, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [
        write(0x60, [0x00]),
        read(0x60, [0x01, 0x11, 0xa5, 0x5a], { dataAcks: [true, true, true, false] }),
      ];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Word addr: RESET'] },
          { classIndex: 1, texts: ['Count: 1'] },
          { classIndex: 5, texts: ['Data: 11'] },
          { classIndex: 6, texts: ['CRC: A5 5A'] },
          { classIndex: 7, texts: ['Status: Ready'] },
        ],
        annotationCount: 5,
        payloadBits: operations.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  yield {
    name: 'invalid-length-and-nack',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 4, sda: 7 },
    options: {},
    chunkSamples: [7, 127],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [write(0x60, [0x03, 0x63, 0x12, 0x00, 0x00, 0x00, 0x00])];
      yield {
        data: operations,
        expected: [SUMMARY],
        expectedAnnotations: [
          { classIndex: 0, texts: ['Word addr: COMMAND'] },
          { classIndex: 1, texts: ['Count: 99'] },
          { classIndex: 8, texts: ['Warning: Invalid frame length: Got 6, expecting 99 '] },
        ],
        annotationCount: 3,
        payloadBits: operations.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  yield {
    name: 'wakeup-without-payload',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 123_456n,
    channels: { scl: 1, sda: 2 },
    options: {},
    chunkSamples: [1, 2, 3],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const operations = [write(0x60, [])];
      yield {
        data: operations,
        expected: [SUMMARY],
        annotationCount: 0,
        payloadBits: operations.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    operationsPerBlock = 800,
    bitsPerOperation = 9 * (1 + commandBytes.length),
    blocks = Math.ceil(required / (operationsPerBlock * bitsPerOperation));
  yield {
    name: 'seeded-long-command-stream',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 2, sda: 5 },
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const operations: I2COperation[] = [];
        for (let index = 0; index < operationsPerBlock; index++) {
          const data = Array.from({ length: 4 }, () => random() & 0xff),
            bytes = command(0x12, 0x02, 0x1234, data, random() & 0xffff);
          operations.push(write(0x60, bytes));
        }
        yield {
          data: operations,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [
            { classIndex: 0, texts: ['Word addr: COMMAND'] },
            { classIndex: 1, texts: ['Count: 11'] },
            { classIndex: 2, texts: ['Opcode: Write'] },
          ],
          annotationCount: operations.length * 7,
          payloadBits: operations.length * bitsPerOperation,
        };
      }
    },
  };
}
