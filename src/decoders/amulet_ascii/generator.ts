import { MIN_PAYLOAD_BITS } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface AmuletItem {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
  readonly gapBits?: number;
}

export interface AmuletCase extends RoundtripCase<AmuletItem> {}

interface Interval {
  readonly ss: bigint;
  readonly es: bigint;
}

const SAMPLE_RATE = 8_000_000;
const BIT_WIDTH = 8;
const UART_OPTIONS = {
  baudrate: 1_000_000,
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
};
const CHANNELS = { rx: 1, tx: 2 } as const;

function schedule(item: AmuletItem, start: bigint, initialUnits = 2): readonly Interval[] {
  let units = initialUnits + (item.gapBits ?? 0);
  return item.bytes.map(() => {
    const startBit = units++;
    units += 9;
    return {
      ss: start + BigInt(startBit + 1) * BigInt(BIT_WIDTH),
      es: start + BigInt(startBit + 9) * BigInt(BIT_WIDTH),
    };
  });
}

function annotation(
  interval: Interval,
  classIndex: number,
  texts?: readonly string[],
  es = interval.es,
): ExpectedFrame {
  return { ss: interval.ss, es, classIndex, ...(texts ? { texts } : {}) };
}

function summary(): ExpectedFrame {
  return { protoId: 'amulet_ascii', kind: 'summary' };
}

const PAGE_CHECKSUM = 0xdb;
const LINE_BYTES = [0xd9, ...Array<number>(16).fill(0x30), 0x30, 0x30];
const RECT_REPLY_BYTES = [0xe9, ...Array<number>(16).fill(0x31), 0x31, 0x31];
const COLOR_BYTES = [0x30, 0x30, 0x30, 0x30, 0x30];

const BOUNDARIES: readonly {
  name: string;
  start: bigint;
  bytes: readonly number[];
  annotationCount: number;
  firstClass: number;
  lastClass: number;
  lastCommandLength: number;
}[] = [
  {
    name: 'page-and-ack',
    start: 9_007_199_254_740_990n,
    bytes: [0xa0, 0x02, 0x41, 0x42, PAGE_CHECKSUM, 0xf0],
    annotationCount: 7,
    firstClass: 42,
    lastClass: 33,
    lastCommandLength: 1,
  },
  {
    name: 'read-write-string-rpc',
    start: 13n,
    bytes: [
      0xd0, 0x31, 0x32, 0xd5, 0x33, 0x34, 0x41, 0x42, 0xd6, 0x35, 0x36, 0x41, 0x42, 0x43, 0x44, 0xd7, 0x37, 0x38, 0x48,
      0x69, 0x00, 0xd8, 0x39, 0x41,
    ],
    annotationCount: 31,
    firstClass: 42,
    lastClass: 9,
    lastCommandLength: 3,
  },
  {
    name: 'arrays-and-replies',
    start: 17n,
    bytes: [
      0xdf, 0x41, 0x42, 0x31, 0x32, 0x33, 0x34, 0x00, 0xf2, 0x43, 0x44, 0x31, 0x32, 0x33, 0x34, 0x00, 0xed, 0x45, 0x46,
      0x31, 0x32, 0x00, 0xee, 0x30, 0x31, 0x31, 0x32, 0x33, 0x34, 0x00, 0xe0, 0x32, 0x33, 0x31, 0x32, 0xe1, 0x34, 0x35,
      0x31, 0x32, 0x33, 0x34, 0xe2, 0x36, 0x37, 0x4f, 0x6b, 0x00, 0xe4, 0x38, 0x39, 0x31, 0x32, 0x00,
    ],
    annotationCount: 60,
    firstClass: 42,
    lastClass: 21,
    lastCommandLength: 6,
  },
  {
    name: 'drawing-colors-and-errors',
    start: 19n,
    bytes: [
      ...LINE_BYTES,
      ...RECT_REPLY_BYTES,
      0xdc,
      0xf4,
      0x31,
      0x32,
      ...COLOR_BYTES,
      0xf7,
      0x33,
      0x34,
      ...COLOR_BYTES,
      0x00,
      0xa0,
      0x03,
      0xd0,
      0x31,
      0x5a,
    ],
    annotationCount: 37,
    firstClass: 42,
    lastClass: 1,
    lastCommandLength: 3,
  },
];

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x414d554c,
}: GenerationOptions = {}): Iterable<AmuletCase> {
  for (const boundary of BOUNDARIES) {
    const item: AmuletItem = { direction: 'rx', bytes: boundary.bytes };
    yield {
      name: boundary.name,
      kind: 'boundary',
      seed,
      sampleRate: SAMPLE_RATE,
      startSample: boundary.start,
      channels: CHANNELS,
      options: {},
      chunkSamples: [1, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        const times = schedule(item, boundary.start);
        yield {
          data: [item],
          expected: [summary()],
          expectedAnnotations: [
            annotation(times[0]!, boundary.firstClass),
            annotation(
              times[times.length - boundary.lastCommandLength]!,
              boundary.lastClass,
              undefined,
              times[times.length - 1]!.es,
            ),
          ],
          annotationCount: boundary.annotationCount,
          payloadBits: boundary.bytes.length * 8,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerBlock = 2048;
  const blocks = Math.max(64, Math.ceil(required / (bytesPerBlock * 8)));
  yield {
    name: 'seeded-long-acks',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      for (let block = 0; block < blocks; block++) {
        const item: AmuletItem = { direction: 'rx', bytes: Array<number>(bytesPerBlock).fill(0xf0) };
        const blockStart = block === 0 ? 0n : BigInt(block * bytesPerBlock * 10 * BIT_WIDTH + 2 * BIT_WIDTH);
        const times = schedule(item, blockStart, block === 0 ? 2 : 0);
        yield {
          data: [item],
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [
            annotation(times[0]!, 42),
            annotation(times[0]!, 33),
            annotation(times[times.length - 1]!, 42),
            annotation(times[times.length - 1]!, 33),
          ],
          annotationCount: bytesPerBlock * 2,
          payloadBits: bytesPerBlock * 8,
        };
      }
    },
  };
}
