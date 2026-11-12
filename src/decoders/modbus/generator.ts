import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface ModbusItem {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
}

export interface ModbusCase extends RoundtripCase<ModbusItem> {}

const UART_OPTIONS = {
  baudrate: 100000,
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
const CHANNELS = { rx: 0, tx: 4 } as const;
const SAMPLE_RATE = 400000;
const WIDTH = SAMPLE_RATE / UART_OPTIONS.baudrate;
const FRAME_BITS = 1 + 8 + 1;
const WITHIN_GAP = 1;
const BETWEEN_GAP = 30;

function crc(bytes: readonly number[]): number[] {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const low = value & 1;
      value >>>= 1;
      if (low) value ^= 0xa001;
    }
  }
  return [value & 0xff, (value >>> 8) & 0xff];
}

function adu(direction: 'rx' | 'tx', body: readonly number[], badCrc = false): ModbusItem {
  const check = crc(body);
  if (badCrc) check[0] ^= 0xff;
  return { direction, bytes: [...body, ...check] };
}

function timing(startSample: bigint) {
  let units = 2;
  return (items: readonly ModbusItem[]): ExpectedFrame[] => {
    const frames: ExpectedFrame[] = [];
    for (const item of items) {
      const first = units,
        last = first + (item.bytes.length - 1) * (FRAME_BITS + WITHIN_GAP);
      frames.push({
        ss: startSample + BigInt(first + 1) * BigInt(WIDTH),
        es: startSample + BigInt(last + 9) * BigInt(WIDTH),
        protoId: 'modbus',
        kind: 'protocol',
        data: ['ADU', item.direction === 'rx' ? 'sc' : 'cs', [...item.bytes]],
      });
      units += item.bytes.length * (FRAME_BITS + WITHIN_GAP) + BETWEEN_GAP;
    }
    return frames;
  };
}

function block(
  items: readonly ModbusItem[],
  expected: readonly ExpectedFrame[],
  expectedAnnotations?: readonly ExpectedFrame[],
) {
  return {
    data: [...items],
    expected: [...expected],
    ...(expectedAnnotations ? { expectedAnnotations } : {}),
    payloadBits: items.reduce((sum, item) => sum + item.bytes.length * 8, 0),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d4f4442,
}: GenerationOptions = {}): Iterable<ModbusCase> {
  const scResponses = [
    adu('rx', [0x11, 0x01, 0x02, 0xcd, 0x01]),
    adu('rx', [0x11, 0x03, 0x04, 0x00, 0x0a, 0x00, 0x0b]),
    adu('rx', [0x11, 0x07, 0x55]),
    adu('rx', [0x11, 0x83, 0x02]),
    adu('rx', [0x11, 0x03, 0x02, 0x00, 0x01], true),
  ];
  const csRequests = [
    adu('tx', [0x11, 0x10, 0x00, 0x01, 0x00, 0x02, 0x04, 0x00, 0x0a, 0x01, 0x02]),
    adu('tx', [0x11, 0x0f, 0x00, 0x13, 0x00, 0x0a, 0x02, 0xcd, 0x01]),
    adu('tx', [0x11, 0x16, 0x00, 0x04, 0x00, 0xff, 0x00, 0x0f]),
    adu('tx', [0x11, 0x17, 0x00, 0x03, 0x00, 0x06, 0x00, 0x0e, 0x00, 0x03, 0x06, 0x00, 0x0a, 0x01, 0x02, 0x03, 0x04]),
  ];
  const boundaryFrames = [
    adu('tx', [0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]),
    adu('rx', [0xf7, 0x07, 0xff]),
    adu('rx', [0x11, 0x06, 0x00, 0x00, 0xff, 0xff]),
  ];
  const addressRegressions = [
    adu('tx', [0x11, 0x01, 0x00, 0x00, 0x00, 0x01]),
    adu('tx', [0x11, 0x02, 0x00, 0x00, 0x00, 0x01]),
    adu('tx', [0x11, 0x03, 0x00, 0x00, 0x00, 0x02]),
    adu('tx', [0x11, 0x04, 0x00, 0x00, 0x00, 0x01]),
    adu('tx', [0x11, 0x05, 0x00, 0x00, 0xff, 0x00]),
    adu('tx', [0x11, 0x06, 0x00, 0x00, 0x12, 0x34]),
    adu('tx', [0x11, 0x0f, 0x00, 0x00, 0x00, 0x08, 0x01, 0xff]),
    adu('tx', [0x11, 0x10, 0x00, 0x00, 0x00, 0x01, 0x02, 0x12, 0x34]),
    adu('tx', [0x11, 0x16, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00]),
    adu('tx', [0x11, 0x17, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x01, 0x02, 0x12, 0x34]),
  ];
  const addressRegressionAnnotations: ExpectedFrame[] = [
    { classIndex: 10, texts: ['Start at address 0x0 / 1'] },
    { classIndex: 10, texts: ['Start at address 0x0 / 10001'] },
    { classIndex: 10, texts: ['Start at address 0x0 / 40001'] },
    { classIndex: 10, texts: ['Start at address 0x0 / 30001'] },
    { classIndex: 10, texts: ['Address 0x0 / 1'] },
    { classIndex: 10, texts: ['Address 0x0 / 40001'] },
    { classIndex: 10, texts: ['Start at address 0x0 / 1'] },
    { classIndex: 10, texts: ['Start at address 0x0 / 40001'] },
    { classIndex: 10, texts: ['Address 0x0 / 40001'] },
    { classIndex: 10, texts: ['Read starting at address 0x0 / 40001'] },
    { classIndex: 10, texts: ['Write starting at address 0x1 / 40002'] },
  ];
  const groups: readonly {
    readonly name: string;
    readonly items: readonly ModbusItem[];
    readonly expectedAnnotations?: readonly ExpectedFrame[];
  }[] = [
    { name: 'sc-responses', items: scResponses },
    { name: 'cs-requests', items: csRequests },
    { name: 'boundaries', items: boundaryFrames },
    { name: 'address-regressions', items: addressRegressions, expectedAnnotations: addressRegressionAnnotations },
  ];
  for (const { name, items, expectedAnnotations } of groups) {
    const startSample = name === 'cs-requests' ? 9_007_199_254_740_990n : 3n,
      time = timing(startSample);
    yield {
      name,
      kind: 'boundary',
      seed,
      sampleRate: SAMPLE_RATE,
      startSample,
      channels: CHANNELS,
      options: { scchannel: 'RX', cschannel: 'TX', framegap: 28 },
      chunkSamples: [1, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        yield block(items, time(items), expectedAnnotations);
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    perBlock = 128,
    count = Math.ceil(required / (9 * 8)),
    blocks = Math.ceil(count / perBlock);
  let generated = 0;
  yield {
    name: 'seeded-long-adus',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: { scchannel: 'RX', cschannel: 'TX', framegap: 28 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const random = randomWords(seed),
        time = timing(0n);
      for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
        const items: ModbusItem[] = [];
        for (let index = 0; index < perBlock && generated < count; index++, generated++) {
          const value1 = random() & 0xffff,
            value2 = random() & 0xffff;
          items.push(
            generated & 1
              ? adu('rx', [0x11, 0x03, 0x04, value1 >>> 8, value1 & 0xff, value2 >>> 8, value2 & 0xff])
              : adu('tx', [
                  0x11,
                  0x10,
                  0x00,
                  generated & 0xff,
                  0x00,
                  0x02,
                  0x04,
                  value1 >>> 8,
                  value1 & 0xff,
                  value2 >>> 8,
                  value2 & 0xff,
                ]),
          );
        }
        const expected = time(items);
        yield block(items, expected);
      }
    },
  };
}
