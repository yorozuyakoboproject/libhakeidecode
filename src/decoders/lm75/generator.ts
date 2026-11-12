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

export interface Lm75Case extends RoundtripCase<I2COperation> {}

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

function temperature(high: number, low: number): { celsius: string; kelvin: string } {
  const celsius = Number(`${high}.${(low >> 7) * 5}`),
    kelvin = celsius + 273.15;
  return { celsius: celsius.toFixed(1), kelvin: kelvin.toFixed(1) };
}

function temperatureAnnotations(ss: bigint, es: bigint, high: number, low: number): ExpectedFrame[] {
  const value = temperature(high, low);
  return [
    { ss, es, classIndex: 0, texts: ['Temperature: ' + value.celsius + ' °C'] },
    { ss, es, classIndex: 1, texts: ['Temperature: ' + value.kelvin + ' K'] },
  ];
}

function warning(ss: bigint, es: bigint, text: string): ExpectedFrame {
  return { ss, es, classIndex: 4, texts: [text] };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4c4d3735,
}: GenerationOptions = {}): Iterable<Lm75Case> {
  yield {
    name: 'temperature-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 9_007_199_254_740_990n,
    channels: { scl: 0, sda: 7 },
    options: { sensor: 'lm75', resolution: 9 },
    chunkSamples: [1, 7, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data: I2COperation[] = [
          { address: 0x48, direction: 'read', data: [0x19, 0x80] },
          { address: 0x40, direction: 'read', data: [0xe7, 0x00] },
          { address: 0x48, direction: 'write', data: [0x00, 0x80] },
        ],
        expectedAnnotations: ExpectedFrame[] = [];
      let cursor = 9_007_199_254_740_993n;
      for (const operation of data) {
        const timing = timeOperation(operation, cursor);
        cursor = timing.next;
        if (operation.address !== 0x48)
          expectedAnnotations.push(
            warning(
              timing.frameStarts[0]!,
              timing.frameEnds[0]!,
              'Warning: I²C slave 0x40 not an LM75 compatible sensor.',
            ),
          );
        expectedAnnotations.push(
          ...temperatureAnnotations(
            timing.frameStarts[1]!,
            timing.frameEnds[2]!,
            operation.data[0]!,
            operation.data[1]!,
          ),
        );
        if (operation.direction === 'write')
          expectedAnnotations.push(
            warning(timing.frameStarts[1]!, timing.frameEnds[2]!, 'Warning: The temperature register is read-only!'),
          );
      }
      yield {
        data,
        expected: [{ protoId: 'lm75', kind: 'summary', annotations: expectedAnnotations.length }],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    count = Math.ceil(required / 27),
    perBlock = 256;
  yield {
    name: 'seeded-long-temperature',
    kind: 'long',
    seed,
    sampleRate: 800_000,
    startSample: 0n,
    channels: { scl: 1, sda: 6 },
    options: { sensor: 'lm75', resolution: 9 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      let cursor = 3n;
      for (let offset = 0; offset < count; offset += perBlock) {
        const data: I2COperation[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const high = random() & 0xff,
            low = random() & 0xff,
            operation: I2COperation = { address: 0x48, direction: 'read', data: [high, low] },
            timing = timeOperation(operation, cursor);
          cursor = timing.next;
          data.push(operation);
          expectedAnnotations.push(...temperatureAnnotations(timing.frameStarts[1]!, timing.frameEnds[2]!, high, low));
        }
        const expected: ExpectedFrame[] =
          offset === 0 ? [{ protoId: 'lm75', kind: 'summary', annotations: count * 2 }] : [];
        yield {
          data,
          expected,
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
        };
      }
    },
  };
}
