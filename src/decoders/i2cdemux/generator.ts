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

export interface I2cdemuxCase extends RoundtripCase<I2COperation> {}

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

function packet(ss: bigint, es: bigint, protoId: string, data: readonly unknown[]): ExpectedFrame {
  return { ss, es, protoId, kind: 'protocol', data };
}

function transferFrames(
  operations: readonly I2COperation[],
  cursor: bigint,
): { expected: ExpectedFrame[]; next: bigint } {
  const timed = operations.map((operation) => timeOperation(operation, cursor));
  let at = cursor;
  for (let index = 0; index < timed.length; index++) {
    const operation = operations[index]!;
    timed[index] = timeOperation(operation, at);
    at = timed[index]!.next;
  }
  const last = operations[operations.length - 1]!,
    protoId = 'i2c-0x' + ((last.address << 1) | (last.direction === 'read' ? 1 : 0)).toString(16),
    expected: ExpectedFrame[] = [];
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!,
      timing = timed[index]!,
      shown = (operation.address << 1) | (operation.direction === 'read' ? 1 : 0);
    if (operation.repeatedStart)
      expected.push(
        packet(timing.start - 1n, timing.start, protoId, ['WARNING', 'Incomplete byte discarded at a repeated START']),
      );
    expected.push(packet(timing.start, timing.start, protoId, ['START', Boolean(operation.repeatedStart)]));
    expected.push(
      packet(timing.frameStarts[0]!, timing.frameEnds[0]!, protoId, [
        'ADDRESS',
        operation.direction,
        shown,
        operation.addressAck !== false,
      ]),
    );
    for (let dataIndex = 0; dataIndex < operation.data.length; dataIndex++)
      expected.push(
        packet(timing.frameStarts[dataIndex + 1]!, timing.frameEnds[dataIndex + 1]!, protoId, [
          'DATA',
          operation.direction,
          operation.data[dataIndex]!,
          operation.dataAcks?.[dataIndex] !== false,
          shown,
        ]),
      );
    if (timing.stop !== null) {
      expected.push(packet(timing.stop - 1n, timing.stop, protoId, ['WARNING', 'Incomplete byte discarded at STOP']));
      expected.push(packet(timing.stop, timing.stop, protoId, ['STOP']));
    }
  }
  return { expected, next: at };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x49324344,
}: GenerationOptions = {}): Iterable<I2cdemuxCase> {
  yield {
    name: 'addresses-and-repeat',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 9_007_199_254_740_990n,
    channels: { scl: 3, sda: 6 },
    options: {},
    chunkSamples: [1, 9, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const first: I2COperation[] = [{ address: 0x48, direction: 'write', data: [0x00, 0x55] }],
        repeated: I2COperation[] = [
          { address: 0x48, direction: 'write', data: [0x01], stop: false },
          { address: 0x49, direction: 'read', data: [0xaa], repeatedStart: true },
        ],
        data = [...first, ...repeated],
        one = transferFrames(first, 9_007_199_254_740_993n),
        two = transferFrames(repeated, one.next);
      yield {
        data,
        expected: [...one.expected, ...two.expected],
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bytes = 16,
    count = Math.ceil(required / (9 * (1 + bytes))),
    perBlock = 128;
  yield {
    name: 'seeded-long-demux',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 1, sda: 6 },
    options: {},
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
            address: index & 1 ? 0x48 : 0x49,
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
