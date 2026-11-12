import { MIN_PAYLOAD_BITS } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface ArmItmItem {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
  readonly gapBits?: number;
}

export interface ArmItmCase extends RoundtripCase<ArmItmItem> {}

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

function schedule(items: readonly ArmItmItem[], start: bigint, initialUnits = 2): readonly Interval[][] {
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

function annotation(interval: Interval, classIndex: number, texts: readonly string[], es = interval.es): ExpectedFrame {
  return { ss: interval.ss, es, classIndex, texts };
}

function summary(): ExpectedFrame {
  return { protoId: 'arm_itm', kind: 'summary' };
}

const TRACE_BYTES = [
  0x70, 0x10, 0x05, 0x20, 0x0e, 0x03, 0x10, 0x17, 0x78, 0x56, 0x34, 0x12, 0x85, 0xaa, 0x47, 0x78, 0x56, 0x34, 0x12,
  0x4e, 0x34, 0x12, 0x02, 0x34, 0x12,
];
const EXCEPTION_BYTES = [0x0e, 0x03, 0x10, 0x0e, 0x03, 0x30, 0x0e, 0x03, 0x20, 0x0e, 0x15, 0x10, 0x0e, 0x15, 0x20];
const SYNC_BYTES = [0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x70];

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x49544d31,
}: GenerationOptions = {}): Iterable<ArmItmCase> {
  const traceItem: ArmItmItem = { direction: 'rx', bytes: TRACE_BYTES };
  yield {
    name: 'trace-packets',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 9_007_199_254_740_990n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule([traceItem], 9_007_199_254_740_990n)[0]!;
      yield {
        data: [traceItem],
        expected: [summary()],
        expectedAnnotations: [
          annotation(time[0]!, 0, ['Overflow']),
          annotation(time[1]!, 1, ['Timestamp: 1 (exact)']),
          annotation(time[2]!, 3, ['DWT events: Cyc'], time[3]!.es),
          annotation(time[4]!, 5, ['Enter: HardFault', 'E HardFault'], time[6]!.es),
          annotation(time[22]!, 2, ['0: 0x1234'], time[24]!.es),
        ],
        annotationCount: 9,
        payloadBits: TRACE_BYTES.length * 8,
      };
    },
  };

  const exceptionItem: ArmItmItem = { direction: 'rx', bytes: EXCEPTION_BYTES };
  yield {
    name: 'exception-modes',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 23n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule([exceptionItem], 23n)[0]!;
      yield {
        data: [exceptionItem],
        expected: [summary()],
        expectedAnnotations: [
          annotation(time[0]!, 5, ['Enter: HardFault', 'E HardFault'], time[2]!.es),
          annotation(time[0]!, 9, ['HardFault'], time[3]!.ss),
          annotation(time[3]!, 5, ['Resume: HardFault', 'R HardFault'], time[5]!.es),
          annotation(time[3]!, 9, ['HardFault'], time[6]!.ss),
          annotation(time[6]!, 5, ['Exit: HardFault', 'X HardFault'], time[8]!.es),
          annotation(time[9]!, 5, ['Enter: IRQ 5', 'E IRQ 5'], time[11]!.es),
          annotation(time[9]!, 8, ['IRQ 5'], time[12]!.ss),
          annotation(time[12]!, 5, ['Exit: IRQ 5', 'X IRQ 5'], time[14]!.es),
        ],
        annotationCount: 8,
        payloadBits: EXCEPTION_BYTES.length * 8,
      };
    },
  };

  const printableItems: readonly ArmItmItem[] = [
    { direction: 'rx', bytes: [0x01, 0x48, 0x01, 0x69] },
    { direction: 'rx', bytes: [0x01, 0x00], gapBits: 200 },
  ];
  yield {
    name: 'delayed-printable-string',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 29n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule(printableItems, 29n);
      yield {
        data: printableItems,
        expected: [summary()],
        expectedAnnotations: [
          annotation(time[0]![0]!, 2, ['0: "Hi"'], time[0]![3]!.es),
          annotation(time[1]![0]!, 2, ['0: 0x00'], time[1]![1]!.es),
        ],
        annotationCount: 2,
        payloadBits: printableItems.reduce((sum, item) => sum + item.bytes.length * 8, 0),
      };
    },
  };

  const syncItem: ArmItmItem = { direction: 'rx', bytes: SYNC_BYTES };
  yield {
    name: 'sync-recovery',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 31n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule([syncItem], 31n)[0]!;
      yield {
        data: [syncItem],
        expected: [summary()],
        expectedAnnotations: [annotation(time[0]!, 0, ['Unhandled sync: 00']), annotation(time[6]!, 0, ['Overflow'])],
        annotationCount: 7,
        payloadBits: SYNC_BYTES.length * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerBlock = 2048;
  const blocks = Math.max(64, Math.ceil(required / (bytesPerBlock * 8)));
  yield {
    name: 'seeded-long-overflow',
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
        const item: ArmItmItem = { direction: 'rx', bytes: Array<number>(bytesPerBlock).fill(0x70) };
        const blockStart = block === 0 ? 0n : BigInt(block * bytesPerBlock * 10 * BIT_WIDTH + 2 * BIT_WIDTH);
        const time = schedule([item], blockStart, block === 0 ? 2 : 0)[0]!;
        yield {
          data: [item],
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [
            annotation(time[0]!, 0, ['Overflow']),
            annotation(time[time.length - 1]!, 0, ['Overflow']),
          ],
          annotationCount: bytesPerBlock,
          payloadBits: bytesPerBlock * 8,
        };
      }
    },
  };
}
