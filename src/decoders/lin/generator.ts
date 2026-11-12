import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import {
  LIN_BIT_WIDTH,
  LIN_BREAK_BITS,
  LIN_BREAK_GAP_BITS,
  LIN_FRAME_BITS,
  LIN_INITIAL_IDLE_BITS,
  LIN_SAMPLE_RATE,
  LIN_TRAILING_IDLE_BITS,
  linMessageByteCount,
  linMessageWireBits,
} from './encoder.js';

export interface LinMessage {
  readonly sync: number;
  readonly pid: number;
  readonly data: readonly number[];
  readonly checksum?: number;
}

export interface LinCase extends RoundtripCase<LinMessage> {}

const UART_OPTIONS = {
  baudrate: 100_000,
  data_bits: 8,
  parity: 'none',
  stop_bits: 1,
  bit_order: 'lsb-first',
  format: 'hex',
  invert_rx: 'no',
  invert_tx: 'no',
  sample_point: 50,
  rx_packet_delim: -1,
  tx_packet_delim: -1,
  rx_packet_len: -1,
  tx_packet_len: -1,
} as const;
const CHANNELS = { rx: 0 } as const;

function parity(pid: number): number {
  const id = Array.from({ length: 8 }, (_, index) => ((pid & 0x3f) >>> index) & 1);
  const p0 = id[0]! ^ id[1]! ^ id[2]! ^ id[4]!;
  const p1 = id[1]! ^ id[3]! ^ id[4]! ^ id[5]! ? 0 : 1;
  return p0 | (p1 << 1);
}

function makePid(id: number): number {
  return (id & 0x3f) | (parity(id & 0x3f) << 6);
}

function checksum(version: number, pid: number, data: readonly number[]): number {
  let total = data.reduce((sum, value) => sum + value, 0);
  if (version === 2) {
    const id = pid & 0x3f;
    if (id !== 60 && id !== 61) total += pid;
  }
  return (0xff - (total & 0xff)) & 0xff;
}

function dataInterval(start: bigint): { readonly ss: bigint; readonly es: bigint } {
  const point = Math.ceil(((LIN_BIT_WIDTH - 1) * 50) / 100) + LIN_BIT_WIDTH;
  return {
    ss: start + BigInt(point - Math.floor(LIN_BIT_WIDTH / 2)),
    es: start + BigInt(point + (LIN_FRAME_BITS - 3) * LIN_BIT_WIDTH + Math.ceil(LIN_BIT_WIDTH / 2)),
  };
}

function messageObservations(message: LinMessage, version: number, breakStart: bigint) {
  const breakEnd = breakStart + BigInt(LIN_BREAK_BITS * LIN_BIT_WIDTH);
  const syncStart = breakEnd + BigInt(LIN_BREAK_GAP_BITS * LIN_BIT_WIDTH);
  const byteStart = (index: number): bigint => syncStart + BigInt(index * LIN_FRAME_BITS * LIN_BIT_WIDTH);
  const expected: ExpectedFrame[] = [
    {
      classIndex: 1,
      texts: ['Break condition', 'Break', 'Brk', 'B'],
      ss: breakStart,
      es: breakEnd,
    },
  ];
  let count = 1;
  const sync = dataInterval(byteStart(0));
  expected.push({ classIndex: 0, texts: ['Sync', 'S'], ss: sync.ss, es: sync.es });
  count++;
  if (message.sync !== 0x55) {
    expected.push({
      classIndex: 2,
      texts: ['Sync is not 0x55', 'Not 0x55', '!= 0x55'],
      ss: sync.ss,
      es: sync.es,
    });
    count++;
  }

  const pidInterval = dataInterval(byteStart(1));
  const id = message.pid & 0x3f;
  const actualParity = message.pid >> 6;
  const expectedParity = parity(id);
  const parityValid = actualParity === expectedParity;
  if (!parityValid) {
    expected.push({
      classIndex: 2,
      texts: [`P != ${expectedParity}`],
      ss: pidInterval.ss,
      es: pidInterval.es,
    });
    count++;
  }
  expected.push({
    classIndex: parityValid ? 0 : 3,
    texts: [
      `ID: ${id.toString(16).toUpperCase().padStart(2, '0')} Parity: ${actualParity} (${parityValid ? 'ok' : 'bad'})`,
      `ID: 0x${id.toString(16).toUpperCase().padStart(2, '0')}`,
      `I: ${id}`,
    ],
    ss: pidInterval.ss,
    es: pidInterval.es,
  });
  count++;

  if (message.data.length && message.checksum !== undefined) {
    for (let index = 0; index < message.data.length; index++) {
      const interval = dataInterval(byteStart(2 + index));
      const hex = message.data[index]!.toString(16).toUpperCase().padStart(2, '0');
      expected.push({ classIndex: 0, texts: [`Data: 0x${hex}`, `D: 0x${hex}`], ss: interval.ss, es: interval.es });
      count++;
    }
    const interval = dataInterval(byteStart(2 + message.data.length));
    const checksumValid = checksum(version, message.pid, message.data) === message.checksum;
    const hex = message.checksum.toString(16).toUpperCase().padStart(2, '0');
    expected.push({
      classIndex: checksumValid ? 0 : 3,
      texts: [`Checksum: 0x${hex}`, 'Checksum', 'Chk', 'C'],
      ss: interval.ss,
      es: interval.es,
    });
    count++;
    if (!checksumValid) {
      expected.push({ classIndex: 2, texts: ['Checksum invalid'], ss: interval.ss, es: interval.es });
      count++;
    }
  }

  const nextBreak =
    syncStart + BigInt((linMessageByteCount(message) * LIN_FRAME_BITS + LIN_TRAILING_IDLE_BITS) * LIN_BIT_WIDTH);
  return { expected, count, nextBreak };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4c494e,
}: GenerationOptions = {}): Iterable<LinCase> {
  const messagesV2: readonly LinMessage[] = [
    { sync: 0x55, pid: makePid(0x00), data: [0x00], checksum: checksum(2, makePid(0), [0]) },
    {
      sync: 0x55,
      pid: makePid(0x3f),
      data: [0xff, 0x00, 0x80, 0x7f, 0x55, 0xaa, 0x01, 0xfe],
      checksum: checksum(2, makePid(0x3f), [0xff, 0x00, 0x80, 0x7f, 0x55, 0xaa, 0x01, 0xfe]),
    },
    { sync: 0x55, pid: makePid(0x3c), data: [0x12, 0x34], checksum: checksum(2, makePid(0x3c), [0x12, 0x34]) },
    {
      sync: 0x54,
      pid: 0x2a | (((parity(0x2a) ^ 3) & 3) << 6),
      data: [0x01, 0x02],
      checksum: (checksum(2, 0x2a | (((parity(0x2a) ^ 3) & 3) << 6), [0x01, 0x02]) ^ 0xff) & 0xff,
    },
    { sync: 0x55, pid: makePid(0x15), data: [] },
  ];
  const boundaryStart = 9_007_199_254_740_990n;
  {
    let cursor = boundaryStart + BigInt(LIN_INITIAL_IDLE_BITS * LIN_BIT_WIDTH);
    const expectedAnnotations: ExpectedFrame[] = [];
    let count = 0;
    let bits = 0;
    for (const message of messagesV2) {
      const observed = messageObservations(message, 2, cursor);
      expectedAnnotations.push(...observed.expected);
      count += observed.count;
      bits += linMessageWireBits(message);
      cursor = observed.nextBreak;
    }
    yield {
      name: 'version-2-boundaries',
      kind: 'boundary',
      seed,
      sampleRate: LIN_SAMPLE_RATE,
      channels: CHANNELS,
      options: { version: 2 },
      startSample: boundaryStart,
      chunkSamples: [1, 3, 17, 257, 1021],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        yield {
          data: [...messagesV2],
          expected: [{ protoId: 'lin', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: bits,
        };
      },
    };
  }

  const messageV1: LinMessage = {
    sync: 0x55,
    pid: makePid(0x20),
    data: [0x11, 0x22, 0x33],
    checksum: checksum(1, makePid(0x20), [0x11, 0x22, 0x33]),
  };
  {
    const observed = messageObservations(messageV1, 1, boundaryStart + BigInt(LIN_INITIAL_IDLE_BITS * LIN_BIT_WIDTH));
    yield {
      name: 'version-1-boundary',
      kind: 'boundary',
      seed,
      sampleRate: LIN_SAMPLE_RATE,
      channels: CHANNELS,
      options: { version: 1 },
      startSample: boundaryStart,
      chunkSamples: [1, 3, 17, 257],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        yield {
          data: [messageV1],
          expected: [{ protoId: 'lin', kind: 'summary' }],
          expectedAnnotations: observed.expected,
          annotationCount: observed.count,
          payloadBits: linMessageWireBits(messageV1),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const messagesPerBlock = 512;
  yield {
    name: 'seeded-version-2-frames',
    kind: 'long',
    seed,
    sampleRate: LIN_SAMPLE_RATE,
    channels: CHANNELS,
    options: { version: 2 },
    startSample: 0n,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const random = randomWords(seed);
      let payloadBits = 0;
      let cursor = BigInt(LIN_INITIAL_IDLE_BITS * LIN_BIT_WIDTH);
      while (payloadBits < required) {
        const messages: LinMessage[] = [];
        const expectedAnnotations: ExpectedFrame[] = [];
        let count = 0;
        for (let index = 0; index < messagesPerBlock; index++) {
          const id = random() & 0x3f;
          const pid = makePid(id);
          const data = Array.from({ length: 8 }, () => random() & 0xff);
          const message: LinMessage = { sync: 0x55, pid, data, checksum: checksum(2, pid, data) };
          const observed = messageObservations(message, 2, cursor);
          cursor = observed.nextBreak;
          payloadBits += linMessageWireBits(message);
          messages.push(message);
          count += observed.count;
          if (index === 0) expectedAnnotations.push(...observed.expected);
        }
        yield {
          data: messages,
          expected:
            messages.length && payloadBits <= messagesPerBlock * linMessageWireBits(messages[0]!)
              ? [{ protoId: 'lin', kind: 'summary' }]
              : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: messages.reduce((sum, message) => sum + linMessageWireBits(message), 0),
        };
      }
    },
  };
}
