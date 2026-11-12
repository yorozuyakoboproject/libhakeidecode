import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { I2CDirection } from '../i2c/index.js';

export interface I2COperation {
  readonly address: number;
  readonly direction: I2CDirection;
  readonly data: readonly number[];
  readonly addressAck?: boolean;
  readonly dataAcks?: readonly boolean[];
  readonly repeatedStart?: boolean;
  readonly stop?: boolean;
}

export interface I2CFilterCase extends RoundtripCase<I2COperation> {}

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'shifted' } }] as const;

interface TimedOperation {
  readonly start: bigint;
  readonly frameStarts: readonly bigint[];
  readonly frameEnds: readonly bigint[];
  readonly stop: bigint | null;
  readonly next: bigint;
}

function timeOperation(operation: I2COperation, cursor: bigint): TimedOperation {
  const start = cursor + 2n,
    frameStarts = [start + 3n],
    frameEnds = [start + 27n];
  for (let index = 1; index <= operation.data.length; index++) {
    frameStarts.push(start + 3n + BigInt(index) * 27n);
    frameEnds.push(start + 27n + BigInt(index) * 27n);
  }
  const lastEnd = frameEnds[frameEnds.length - 1]!,
    stop = operation.stop === false ? null : lastEnd + 4n;
  return { start, frameStarts, frameEnds, stop, next: stop === null ? lastEnd + 2n : stop + 2n };
}

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

function packet(ss: bigint, es: bigint, data: readonly unknown[]): ExpectedFrame {
  return { ss, es, protoId: 'i2c', kind: 'protocol', data };
}

function transferFrames(
  operations: readonly I2COperation[],
  cursor: bigint,
): { expected: ExpectedFrame[]; next: bigint } {
  const expected: ExpectedFrame[] = [];
  let at = cursor;
  for (const operation of operations) {
    const timing = timeOperation(operation, at),
      shown = (operation.address << 1) | (operation.direction === 'read' ? 1 : 0);
    at = timing.next;
    if (operation.repeatedStart)
      expected.push(
        packet(timing.start - 1n, timing.start, ['WARNING', 'Incomplete byte discarded at a repeated START']),
      );
    expected.push(packet(timing.start, timing.start, ['START', Boolean(operation.repeatedStart)]));
    expected.push(
      packet(timing.frameStarts[0]!, timing.frameEnds[0]!, [
        'ADDRESS',
        operation.direction,
        shown,
        operation.addressAck !== false,
      ]),
    );
    for (let index = 0; index < operation.data.length; index++)
      expected.push(
        packet(timing.frameStarts[index + 1]!, timing.frameEnds[index + 1]!, [
          'DATA',
          operation.direction,
          operation.data[index]!,
          operation.dataAcks?.[index] !== false,
          shown,
        ]),
      );
    if (timing.stop !== null) {
      expected.push(packet(timing.stop - 1n, timing.stop, ['WARNING', 'Incomplete byte discarded at STOP']));
      expected.push(packet(timing.stop, timing.stop, ['STOP']));
    }
  }
  return { expected, next: at };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x49324346,
}: GenerationOptions = {}): Iterable<I2CFilterCase> {
  const matchAddress: I2COperation[] = [
      { address: 0x3a, direction: 'write', data: [0x10], stop: false },
      { address: 0x3a, direction: 'read', data: [0x5a, 0xa5], repeatedStart: true },
    ],
    otherAddress: I2COperation[] = [{ address: 0x48, direction: 'write', data: [0x22] }];
  yield {
    name: 'address-filter-with-repeat',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 17n,
    channels: { scl: 1, sda: 6 },
    options: { address: 0x3a, direction: 'both' },
    chunkSamples: [1, 7, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const first = transferFrames(otherAddress, 20n),
        second = transferFrames(matchAddress, first.next),
        data = [...otherAddress, ...matchAddress];
      yield {
        data,
        expected: second.expected,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };
  yield {
    name: 'direction-filter',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 9_007_199_254_740_990n,
    channels: { scl: 4, sda: 2 },
    options: { address: 0, direction: 'read' },
    chunkSamples: [3, 31, 513],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const write: I2COperation[] = [{ address: 0x20, direction: 'write', data: [0x00, 0x01] }],
        read: I2COperation[] = [{ address: 0x20, direction: 'read', data: [0xfe, 0xdc, 0xba] }],
        first = transferFrames(write, 9_007_199_254_740_993n),
        second = transferFrames(read, first.next),
        data = [...write, ...read];
      yield {
        data,
        expected: second.expected,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bytes = 16,
    count = Math.ceil(required / (9 * (1 + bytes))),
    perBlock = 128;
  yield {
    name: 'seeded-long-filter-all',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 1, sda: 6 },
    options: { address: 0, direction: 'both' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      let cursor = 3n;
      for (let offset = 0; offset < count; offset += perBlock) {
        const data: I2COperation[] = [],
          expected: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const operation: I2COperation = {
            address: 0x20 + (index % 0x10),
            direction: index & 1 ? 'read' : 'write',
            data: Array.from({ length: bytes }, () => random() & 0xff),
          };
          data.push(operation);
          const frames = transferFrames([operation], cursor);
          cursor = frames.next;
          expected.push(...frames.expected);
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
