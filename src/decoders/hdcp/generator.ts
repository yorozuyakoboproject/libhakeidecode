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

export interface HdcpCase extends RoundtripCase<I2COperation> {}

const MESSAGE_IDS: Readonly<Record<number, string>> = {
  2: 'AKE_Init',
  3: 'AKE_Send_Cert',
  4: 'AKE_No_stored_km',
  5: 'AKE_Stored_km',
  7: 'AKE_Send_H_prime',
  8: 'AKE_Send_Pairing_Info',
  9: 'LC_Init',
  10: 'LC_Send_L_prime',
  11: 'SKE_Send_Eks',
  12: 'RepeaterAuth_Send_ReceiverID_List',
  15: 'RepeaterAuth_Send_Ack',
  16: 'RepeaterAuth_Stream_Manage',
  17: 'RepeaterAuth_Stream_Ready',
};

const CHAIN = [{ decoder: 'i2c', options: { address_format: 'shifted' } }] as const;

interface TimedOperation {
  readonly start: bigint;
  readonly frameEnds: readonly bigint[];
  readonly stop: bigint | null;
  readonly next: bigint;
}

function timeOperation(operation: I2COperation, cursor: bigint): TimedOperation {
  const start = cursor + 2n,
    frameEnds = [start + 27n];
  for (let index = 1; index <= operation.data.length; index++) frameEnds.push(start + 27n + BigInt(index) * 27n);
  const lastEnd = frameEnds[frameEnds.length - 1]!,
    stop = operation.stop === false ? null : lastEnd + 4n;
  return { start, frameEnds, stop, next: stop === null ? lastEnd + 2n : stop + 2n };
}

function operationBits(operation: I2COperation): number {
  return 9 * (1 + operation.data.length);
}

function annotation(ss: bigint, es: bigint, classIndex: number, text: string): ExpectedFrame {
  return { ss, es, classIndex, texts: [text] };
}

function protocol(ss: bigint, es: bigint, data: readonly unknown[]): ExpectedFrame {
  return { ss, es, protoId: 'hdcp', kind: 'protocol', data };
}

function transfer(
  operations: readonly I2COperation[],
  cursor: bigint,
): { start: bigint; stop: bigint; next: bigint; timed: readonly TimedOperation[] } {
  const timed: TimedOperation[] = [];
  let at = cursor;
  for (const operation of operations) {
    const current = timeOperation(operation, at);
    timed.push(current);
    at = current.next;
  }
  const stop = timed[timed.length - 1]!.stop;
  if (stop === null) throw new Error('HDCP transfer must end with STOP');
  return { start: timed[0]!.start, stop, next: at, timed };
}

function expectedMessage(
  operations: readonly I2COperation[],
  cursor: bigint,
  message: number,
  text: string,
): { expected: ExpectedFrame[]; expectedAnnotations: ExpectedFrame[]; next: bigint } {
  const range = transfer(operations, cursor),
    classIndex = message >= 0 && message < 18 ? message : 18;
  return {
    expected: [protocol(range.start, range.stop, ['MESSAGE', message, text])],
    expectedAnnotations: [annotation(range.start, range.stop, classIndex, text)],
    next: range.next,
  };
}

function expectedSummary(
  operations: readonly I2COperation[],
  cursor: bigint,
  text: string,
): { expected: ExpectedFrame[]; expectedAnnotations: ExpectedFrame[]; next: bigint } {
  const range = transfer(operations, cursor);
  return {
    expected: [protocol(range.start, range.stop, ['SUMMARY', text])],
    expectedAnnotations: [annotation(range.start, range.stop, 18, text)],
    next: range.next,
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x48444350,
}: GenerationOptions = {}): Iterable<HdcpCase> {
  const readMessage: I2COperation[] = [
      { address: 0x3a, direction: 'write', data: [0x80], stop: false },
      { address: 0x3a, direction: 'read', data: [0x02], repeatedStart: true },
    ],
    writeMessage: I2COperation[] = [{ address: 0x3a, direction: 'write', data: [0x60, 0x11, 0xaa, 0x55] }],
    summaries: { operations: I2COperation[]; text: string }[] = [
      {
        operations: [
          { address: 0x3a, direction: 'write', data: [0x70], stop: false },
          { address: 0x3a, direction: 'read', data: [0xff, 0x0f], repeatedStart: true },
        ],
        text: 'RxStatus, reauth True, ready True, length 1023',
      },
      {
        operations: [
          { address: 0x3a, direction: 'write', data: [0x41], stop: false },
          { address: 0x3a, direction: 'read', data: [0x83, 0x12], repeatedStart: true },
        ],
        text: '1.4 Bstatus, 3 devices, depth 2, hdmi mode True',
      },
      {
        operations: [
          { address: 0x3a, direction: 'write', data: [0x50], stop: false },
          { address: 0x3a, direction: 'read', data: [0x04], repeatedStart: true },
        ],
        text: 'HDCP2',
      },
      {
        operations: [{ address: 0x3a, direction: 'write', data: [0x10] }],
        text: '1.4 Aksv - Transmitter KSV',
      },
    ];
  yield {
    name: 'read-write-messages',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 9_007_199_254_740_990n,
    channels: { scl: 0, sda: 7 },
    options: {},
    chunkSamples: [1, 7, 257, 4093],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data = [...readMessage, ...writeMessage],
        expected: ExpectedFrame[] = [],
        expectedAnnotations: ExpectedFrame[] = [];
      let cursor = 9_007_199_254_740_993n;
      const first = expectedMessage(readMessage, cursor, 0x02, 'Read_Message, AKE_Init');
      expected.push(...first.expected);
      expectedAnnotations.push(...first.expectedAnnotations);
      cursor = first.next;
      const second = expectedMessage(writeMessage, cursor, 0x11, 'Write_Message, RepeaterAuth_Stream_Ready');
      expected.push(...second.expected);
      expectedAnnotations.push(...second.expectedAnnotations);
      yield {
        data,
        expected,
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };
  yield {
    name: 'status-summaries',
    kind: 'boundary',
    seed,
    sampleRate: 800_000,
    startSample: 31n,
    channels: { scl: 2, sda: 5 },
    options: {},
    chunkSamples: [3, 17, 511],
    minimumPayloadBits: 0,
    chain: CHAIN,
    *generate() {
      const data: I2COperation[] = [],
        expected: ExpectedFrame[] = [],
        expectedAnnotations: ExpectedFrame[] = [];
      let cursor = 34n;
      for (const summary of summaries) {
        const item = expectedSummary(summary.operations, cursor, summary.text);
        data.push(...summary.operations);
        expected.push(...item.expected);
        expectedAnnotations.push(...item.expectedAnnotations);
        cursor = item.next;
      }
      yield {
        data,
        expected,
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    bytes = 16,
    bitsPerMessage = 9 * (2 + bytes),
    count = Math.ceil(required / bitsPerMessage),
    perBlock = 64;
  yield {
    name: 'seeded-long-write-messages',
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
          expected: ExpectedFrame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(count, offset + perBlock); index++) {
          const message = random() % 18,
            values = Array.from({ length: bytes }, () => random() & 0xff),
            operation: I2COperation = {
              address: 0x3a,
              direction: 'write',
              data: [0x60, message, ...values],
            },
            range = transfer([operation], cursor),
            text = 'Write_Message, ' + (MESSAGE_IDS[message] ?? 'Invalid');
          cursor = range.next;
          data.push(operation);
          expected.push(protocol(range.start, range.stop, ['MESSAGE', message, text]));
          expectedAnnotations.push(annotation(range.start, range.stop, message, text));
        }
        yield {
          data,
          expected,
          expectedAnnotations,
          annotationCount: expected.length,
          payloadBits: data.reduce((sum, operation) => sum + operationBits(operation), 0),
        };
      }
    },
  };
}
