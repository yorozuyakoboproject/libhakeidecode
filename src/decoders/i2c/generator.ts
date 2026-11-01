import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { I2CDirection } from './index.js';

export interface I2COperation {
  readonly address: number;
  readonly addressBits: 7 | 10;
  readonly direction: I2CDirection;
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface I2CCase extends RoundtripCase<I2COperation> {}

function shownAddress(operation: I2COperation, shifted: boolean): number {
  if (!shifted) return operation.address;
  return operation.address * 2 + (operation.direction === 'read' ? 1 : 0);
}

function expectedFrames(operation: I2COperation, shifted: boolean): { frames: ExpectedFrame[]; address: number } {
  const address = shownAddress(operation, shifted);
  const frames: ExpectedFrame[] = [
    {
      kind: 'address',
      direction: operation.direction,
      value: address,
      address,
      ack: operation.addressAck ?? true,
    },
  ];
  for (let index = 0; index < operation.data.length; index++)
    frames.push({
      kind: 'data',
      direction: operation.direction,
      value: operation.data[index]!,
      address,
      ack: operation.dataAcks?.[index] ?? true,
    });
  return { frames, address };
}

function operationBits(operation: I2COperation): number {
  return 9 * ((operation.addressBits === 10 ? 1 : 0) + 1 + operation.data.length);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x493243,
}: GenerationOptions = {}): Iterable<I2CCase> {
  const boundary = [
    { name: 'seven-bit-write-shifted', shifted: true, addressBits: 7 as const, direction: 'write' as const },
    { name: 'seven-bit-read-unshifted', shifted: false, addressBits: 7 as const, direction: 'read' as const },
    { name: 'ten-bit-write-shifted', shifted: true, addressBits: 10 as const, direction: 'write' as const },
    { name: 'ten-bit-read-unshifted', shifted: false, addressBits: 10 as const, direction: 'read' as const },
    { name: 'nack-and-repeated-start', shifted: true, addressBits: 7 as const, direction: 'write' as const },
  ];
  for (const item of boundary) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: 2_000_000,
      startSample: item.name === 'nack-and-repeated-start' ? 9_007_199_254_740_990n : 17n,
      channels: { scl: 2, sda: 5 },
      options: { address_format: item.shifted ? 'shifted' : 'unshifted' },
      chunkSamples: [1, 17, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        const operations: I2COperation[] =
          item.name === 'nack-and-repeated-start'
            ? [
                {
                  address: 0x52,
                  addressBits: 7,
                  direction: 'write',
                  data: [0x10, 0x20],
                  dataAcks: [true, false],
                  stop: false,
                },
                {
                  address: 0x53,
                  addressBits: 7,
                  direction: 'read',
                  data: [0xa5],
                  addressAck: false,
                  repeatedStart: true,
                },
              ]
            : [
                {
                  address: item.addressBits === 10 ? 0x2a5 : 0x42,
                  addressBits: item.addressBits,
                  direction: item.direction,
                  data: item.direction === 'read' ? [0x00, 0x7f, 0xff] : [0x00, 0x55, 0xaa, 0xff],
                },
              ];
        const expected = operations.flatMap((operation) => expectedFrames(operation, item.shifted).frames);
        yield {
          data: operations,
          expected,
          payloadBits: operations.reduce((sum, operation) => sum + operationBits(operation), 0),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const prefix = [
    { address: 0x21, addressBits: 7 as const, direction: 'write' as const },
    { address: 0x3a, addressBits: 7 as const, direction: 'read' as const },
    { address: 0x2a5, addressBits: 10 as const, direction: 'write' as const },
    { address: 0x155, addressBits: 10 as const, direction: 'read' as const },
  ];
  const perBlock = 128;
  const maxBitsPerBlock = perBlock * 17 * 9;
  const blocks = Math.ceil(required / maxBitsPerBlock);
  yield {
    name: 'seeded-long-mixed-addresses',
    kind: 'long',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: { scl: 1, sda: 6 },
    options: { address_format: 'shifted' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: I2COperation[] = [],
          expected: ExpectedFrame[] = [];
        for (let index = 0; index < perBlock; index++) {
          const base = prefix[(block * perBlock + index) % prefix.length]!;
          const operation: I2COperation = {
            ...base,
            address: base.addressBits === 10 ? base.address & 0x3ff : base.address & 0x7f,
            data: Array.from({ length: 16 }, () => random() & 0xff),
            stop: true,
          };
          data.push(operation);
          expected.push(...expectedFrames(operation, true).frames);
        }
        yield {
          data,
          expected,
          payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
        };
      }
    },
  };
}
