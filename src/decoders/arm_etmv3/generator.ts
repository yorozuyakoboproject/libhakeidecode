import { MIN_PAYLOAD_BITS } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface ArmEtmv3Item {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
  readonly gapBits?: number;
}

export interface ArmEtmv3Case extends RoundtripCase<ArmEtmv3Item> {}

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

function schedule(item: ArmEtmv3Item, start: bigint, initialUnits = 2): readonly Interval[] {
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

function annotation(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): ExpectedFrame {
  return { ss, es, classIndex, texts };
}

function summary(): ExpectedFrame {
  return { protoId: 'arm_etmv3', kind: 'summary' };
}

const FLOW_BYTES = [
  0x00, 0x00, 0x00, 0x00, 0x80, 0x05, 0x84, 0x7e, 0x76, 0x0c, 0x08, 0x20, 0x10, 0x00, 0x00, 0x00, 0x66,
];

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x45544d33,
}: GenerationOptions = {}): Iterable<ArmEtmv3Case> {
  const flowItem: ArmEtmv3Item = { direction: 'rx', bytes: FLOW_BYTES };
  yield {
    name: 'flow-and-sync',
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
      const time = schedule(flowItem, 9_007_199_254_740_990n);
      yield {
        data: [flowItem],
        expected: [summary()],
        expectedAnnotations: [
          annotation(time[0]!.ss, time[4]!.es, 0, ['Synchronization']),
          annotation(time[5]!.ss, time[5]!.es, 1, ['Branch to 0x00000008', 'B 0x00000008']),
          annotation(time[6]!.ss, time[6]!.es, 5, ['PC 0x00000008', '0x00000008', '00000008']),
          annotation(time[6]!.ss, time[6]!.es, 3, ['1 instructions executed', '1 ins exec', '1E']),
          annotation(time[7]!.ss, time[7]!.es, 2, ['Exception entry']),
          annotation(time[8]!.ss, time[8]!.es, 2, ['Exception exit']),
          annotation(time[9]!.ss, time[9]!.es, 0, ['Trigger event', 'Trigger']),
          annotation(time[10]!.ss, time[15]!.es, 0, [
            'I-Sync: Tracing enabled, PC 0x00000010, arm state',
            'I-Sync: Tracing enabled 0x00000010',
          ]),
          annotation(time[16]!.ss, time[16]!.es, 0, ['Unhandled ignore: 66']),
        ],
        annotationCount: 9,
        payloadBits: FLOW_BYTES.length * 8,
      };
    },
  };

  const alternativeItem: ArmEtmv3Item = { direction: 'rx', bytes: [0xc5, 0x40, 0x00] };
  yield {
    name: 'alternative-exception-branch',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 37n,
    channels: CHANNELS,
    options: { branch_enc: 'alternative' },
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule(alternativeItem, 37n);
      yield {
        data: [alternativeItem],
        expected: [summary()],
        expectedAnnotations: [annotation(time[0]!.ss, time[2]!.es, 2, ['Branch to 0x00000088', 'B 0x00000088'])],
        annotationCount: 1,
        payloadBits: alternativeItem.bytes.length * 8,
      };
    },
  };

  const originalItem: ArmEtmv3Item = {
    direction: 'rx',
    bytes: [0x85, 0x80, 0x80, 0x80, 0x48, 0x00],
  };
  yield {
    name: 'original-exception-branch',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 41n,
    channels: CHANNELS,
    options: { branch_enc: 'original' },
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule(originalItem, 41n);
      yield {
        data: [originalItem],
        expected: [summary()],
        expectedAnnotations: [annotation(time[0]!.ss, time[5]!.es, 2, ['Branch to 0x00000008', 'B 0x00000008'])],
        annotationCount: 1,
        payloadBits: originalItem.bytes.length * 8,
      };
    },
  };

  const pairItem: ArmEtmv3Item = { direction: 'rx', bytes: [0x82] };
  yield {
    name: 'paired-p-header',
    kind: 'boundary',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 43n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const time = schedule(pairItem, 43n)[0]!;
      yield {
        data: [pairItem],
        expected: [summary()],
        expectedAnnotations: [
          annotation(time.ss, time.ss + 32n, 5, ['PC 0x00000000', '0x00000000', '00000000']),
          annotation(time.ss + 32n, time.es, 5, ['PC 0x00000004', '0x00000004', '00000004']),
          annotation(time.ss, time.es, 3, ['Instruction 1 executed, instruction 2 executed', 'I1 E, I2 E', 'E,E']),
        ],
        annotationCount: 3,
        payloadBits: 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerBlock = 2048;
  const blocks = Math.max(64, Math.ceil(required / (bytesPerBlock * 8)));
  yield {
    name: 'seeded-long-execution',
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
        const item: ArmEtmv3Item = { direction: 'rx', bytes: Array<number>(bytesPerBlock).fill(0x84) };
        const blockStart = block === 0 ? 0n : BigInt(block * bytesPerBlock * 10 * BIT_WIDTH + 2 * BIT_WIDTH);
        const time = schedule(item, blockStart, block === 0 ? 2 : 0);
        const firstPc = block * bytesPerBlock * 4;
        const lastPc = firstPc + bytesPerBlock * 4 - 4;
        yield {
          data: [item],
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [
            annotation(time[0]!.ss, time[0]!.es, 5, [
              `PC 0x${firstPc.toString(16).padStart(8, '0')}`,
              `0x${firstPc.toString(16).padStart(8, '0')}`,
              firstPc.toString(16).padStart(8, '0'),
            ]),
            annotation(time[0]!.ss, time[0]!.es, 3, ['1 instructions executed', '1 ins exec', '1E']),
            annotation(time[time.length - 1]!.ss, time[time.length - 1]!.es, 5, [
              `PC 0x${lastPc.toString(16).padStart(8, '0')}`,
              `0x${lastPc.toString(16).padStart(8, '0')}`,
              lastPc.toString(16).padStart(8, '0'),
            ]),
            annotation(time[time.length - 1]!.ss, time[time.length - 1]!.es, 3, [
              '1 instructions executed',
              '1 ins exec',
              '1E',
            ]),
          ],
          annotationCount: bytesPerBlock * 2,
          payloadBits: bytesPerBlock * 8,
        };
      }
    },
  };
}
