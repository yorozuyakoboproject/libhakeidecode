import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface TpiuItem {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
  readonly gapBits?: number;
}

export interface TpiuCase extends RoundtripCase<TpiuItem> {}

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

function schedule(items: readonly TpiuItem[], start: bigint, initialUnits = 2): readonly Interval[][] {
  let units = initialUnits;
  return items.map((item) => {
    units += item.gapBits ?? 0;
    const intervals = item.bytes.map(() => {
      const startBit = units++;
      units += 9;
      return {
        ss: start + BigInt(startBit + 1) * BigInt(BIT_WIDTH),
        es: start + BigInt(startBit + 9) * BigInt(BIT_WIDTH),
      };
    });
    return intervals;
  });
}

function frame(interval: Interval, value: number): ExpectedFrame {
  return {
    ss: interval.ss,
    es: interval.es,
    protoId: 'uart',
    kind: 'protocol',
    data: ['DATA', 0, [value, []]],
  };
}

function annotation(
  interval: Interval,
  classIndex: number,
  texts: readonly string[],
  ss = interval.ss,
  es = interval.es,
): ExpectedFrame {
  return { ss, es, classIndex, texts };
}

const STREAM_ONE_FRAME = [
  0x03, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x00,
];
const STREAM_CHANGE_FRAME = [
  0x03, 0x11, 0x22, 0x33, 0x05, 0x50, 0x03, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x04,
];
const PLAIN_FRAME = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x00];

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x54504955,
}: GenerationOptions = {}): Iterable<TpiuCase> {
  const boundaries: readonly {
    name: string;
    start: bigint;
    options: { stream: number; sync_offset: number };
    items: readonly TpiuItem[];
    expected: (times: readonly Interval[][]) => {
      frames: ExpectedFrame[];
      annotations: ExpectedFrame[];
      annotationCount: number;
    };
  }[] = [
    {
      name: 'stream-one',
      start: 9_007_199_254_740_990n,
      options: { stream: 1, sync_offset: 0 },
      items: [{ direction: 'rx', bytes: STREAM_ONE_FRAME }],
      expected: ([word]) => {
        const frames = word!.slice(1, 15).map((time, index) => frame(time, STREAM_ONE_FRAME[index + 1]!));
        const annotations = word!
          .slice(1, 15)
          .map((time, index) =>
            annotation(time, 1, [`0x${STREAM_ONE_FRAME[index + 1]!.toString(16).padStart(2, '0')}`]),
          );
        return { frames, annotations, annotationCount: annotations.length };
      },
    },
    {
      name: 'stream-change',
      start: 11n,
      options: { stream: 1, sync_offset: 0 },
      items: [{ direction: 'rx', bytes: STREAM_CHANGE_FRAME }],
      expected: ([word]) => {
        const time = word!;
        return {
          frames: [
            frame(time[1]!, 0x11),
            frame(time[2]!, 0x22),
            frame(time[3]!, 0x33),
            frame(time[5]!, 0x50),
            ...[7, 8, 9, 10, 11, 12, 13, 14].map((index) => frame(time[index]!, STREAM_CHANGE_FRAME[index]!)),
          ],
          annotations: [
            annotation(time[1]!, 0, ['Stream 1', 'S1'], time[0]!.ss, time[5]!.es),
            annotation(time[7]!, 0, ['Stream 2', 'S2'], time[5]!.es, time[6]!.ss),
          ],
          annotationCount: 14,
        };
      },
    },
    {
      name: 'sync-recovery',
      start: 5n,
      options: { stream: 1, sync_offset: 0 },
      items: [
        {
          direction: 'rx',
          bytes: [0xaa, 0xbb, 0xff, 0xff, 0xff, 0x7f, ...STREAM_ONE_FRAME],
        },
      ],
      expected: ([word]) => {
        const frames = STREAM_ONE_FRAME.slice(1, 15).map((value, index) => frame(word![7 + index]!, value));
        return {
          frames,
          annotations: [annotation(word![7]!, 1, [`0x${STREAM_ONE_FRAME[1]!.toString(16).padStart(2, '0')}`])],
          annotationCount: frames.length,
        };
      },
    },
    {
      name: 'pause-reset',
      start: 0n,
      options: { stream: 0, sync_offset: 0 },
      items: [
        { direction: 'rx', bytes: [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17] },
        { direction: 'rx', bytes: PLAIN_FRAME, gapBits: 200 },
      ],
      expected: ([, word]) => {
        const frames = PLAIN_FRAME.slice(0, 15).map((value, index) => frame(word![index]!, value));
        return {
          frames,
          annotations: [annotation(word![0]!, 1, ['0x00'])],
          annotationCount: frames.length,
        };
      },
    },
    {
      name: 'sync-offset',
      start: 7n,
      options: { stream: 0, sync_offset: 4 },
      items: [{ direction: 'rx', bytes: [0x31, 0x32, 0x33, ...PLAIN_FRAME] }],
      expected: ([word]) => {
        const frames = PLAIN_FRAME.slice(0, 15).map((value, index) => frame(word![3 + index]!, value));
        return {
          frames,
          annotations: [annotation(word![3]!, 1, ['0x00'])],
          annotationCount: frames.length,
        };
      },
    },
  ];
  for (const boundary of boundaries) {
    yield {
      name: boundary.name,
      kind: 'boundary',
      seed,
      sampleRate: SAMPLE_RATE,
      startSample: boundary.start,
      channels: CHANNELS,
      options: boundary.options,
      chunkSamples: [1, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        const times = schedule(boundary.items, boundary.start);
        const expected = boundary.expected(times);
        yield {
          data: boundary.items,
          expected: expected.frames,
          expectedAnnotations: expected.annotations,
          annotationCount: expected.annotationCount,
          payloadBits: boundary.items.reduce((sum, item) => sum + item.bytes.length * 8, 0),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const wordsPerBlock = 2048;
  const framesPerBlock = wordsPerBlock / 16;
  const blocks = Math.max(64, Math.ceil(required / (wordsPerBlock * 8)));
  yield {
    name: 'seeded-long-stream',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: { stream: 1, sync_offset: 0 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const bytes: number[] = [];
        const values: number[][] = [];
        for (let index = 0; index < framesPerBlock; index++) {
          const valuesInFrame = [0x03];
          for (let byte = 1; byte < 15; byte++) valuesInFrame.push(random() & 0xff & (byte % 2 === 0 ? 0xfe : 0xff));
          valuesInFrame.push(0x00);
          values.push(valuesInFrame);
          bytes.push(...valuesInFrame);
        }
        const blockStart = block === 0 ? 0n : BigInt(block * wordsPerBlock * 10 * BIT_WIDTH + 2 * BIT_WIDTH);
        const times = schedule([{ direction: 'rx', bytes }], blockStart, block === 0 ? 2 : 0)[0]!;
        const expected: ExpectedFrame[] = [];
        const annotations: ExpectedFrame[] = [];
        for (let index = 0; index < values.length; index++) {
          const offset = index * 16;
          for (let byte = 1; byte < 15; byte++) {
            expected.push(frame(times[offset + byte]!, values[index]![byte]!));
            if (index === 0 && byte === 1)
              annotations.push(
                annotation(times[offset + byte]!, 1, [`0x${values[index]![byte]!.toString(16).padStart(2, '0')}`]),
              );
          }
        }
        yield {
          data: [{ direction: 'rx', bytes }],
          expected,
          expectedAnnotations: annotations,
          annotationCount: values.length * 14,
          payloadBits: bytes.length * 8,
        };
      }
    },
  };
}
