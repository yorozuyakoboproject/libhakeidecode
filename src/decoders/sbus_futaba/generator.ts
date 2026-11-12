import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface SbusMessage {
  readonly direction: 'rx' | 'tx';
  readonly bytes: readonly number[];
}

export interface SbusCase extends RoundtripCase<SbusMessage> {}

const UART_OPTIONS = {
  baudrate: 100000,
  data_bits: 8,
  parity: 'even',
  stop_bits: 2,
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
const CHANNELS = { rx: 2, tx: 6 } as const;
const SAMPLE_RATE = 400000;
const WIDTH = SAMPLE_RATE / UART_OPTIONS.baudrate;
const FRAME_BITS = 1 + 8 + 1 + 2;
const WITHIN_GAP = 1;
const BETWEEN_GAP = 12;

function packBits(fields: readonly (readonly [number, number])[]): number[] {
  const bits: number[] = [];
  for (const [value, count] of fields) for (let index = 0; index < count; index++) bits.push((value >>> index) & 1);
  return Array.from({ length: bits.length / 8 }, (_, byte) =>
    bits.slice(byte * 8, byte * 8 + 8).reduce((value, bit, index) => value + bit * 2 ** index, 0),
  );
}

function message(
  header: number,
  proportional: readonly number[],
  digital: readonly [number, number],
  flags: number,
  padding: number,
  footer: number,
  direction: 'rx' | 'tx' = 'tx',
): SbusMessage {
  return {
    direction,
    bytes: packBits([
      [header, 8],
      ...proportional.map((value) => [value, 11] as const),
      [digital[0], 1],
      [digital[1], 1],
      [flags & 1, 1],
      [(flags >>> 1) & 1, 1],
      [padding, 4],
      [footer, 8],
    ]),
  };
}

function bitAt(bytes: readonly number[], index: number): number {
  return (bytes[Math.floor(index / 8)]! >>> (index % 8)) & 1;
}

function valueAt(message: SbusMessage, start: number, count: number): number {
  let value = 0;
  for (let index = 0; index < count; index++) value += bitAt(message.bytes, start + index) * 2 ** index;
  return value;
}

function fieldInterval(
  frameStart: number,
  start: number,
  count: number,
  startSample: bigint,
): { ss: bigint; es: bigint } {
  const first = frameStart + Math.floor(start / 8) * (FRAME_BITS + WITHIN_GAP) + 1 + (start % 8);
  const lastBit = start + count - 1;
  const last = frameStart + Math.floor(lastBit / 8) * (FRAME_BITS + WITHIN_GAP) + 1 + (lastBit % 8) + 1;
  return {
    ss: startSample + BigInt(first) * BigInt(WIDTH),
    es: startSample + BigInt(last) * BigInt(WIDTH),
  };
}

function expected(message: SbusMessage, frameStart: number, startSample: bigint): ExpectedFrame[] {
  const frames: ExpectedFrame[] = [],
    own = (start: number, count: number) => fieldInterval(frameStart, start, count, startSample);
  let field = own(0, 8);
  frames.push({
    ss: field.ss,
    es: field.es,
    protoId: 'sbus_futaba',
    kind: 'protocol',
    data: ['HEADER', valueAt(message, 0, 8)],
  });
  for (let channel = 0; channel < 16; channel++) {
    field = own(8 + channel * 11, 11);
    frames.push({
      ss: field.ss,
      es: field.es,
      protoId: 'sbus_futaba',
      kind: 'protocol',
      data: ['PROPORTIONAL', [channel + 1, valueAt(message, 8 + channel * 11, 11)]],
    });
  }
  for (let channel = 0; channel < 2; channel++) {
    field = own(184 + channel, 1);
    frames.push({
      ss: field.ss,
      es: field.es,
      protoId: 'sbus_futaba',
      kind: 'protocol',
      data: ['DIGITAL', [17 + channel, valueAt(message, 184 + channel, 1)]],
    });
  }
  for (let flag = 0; flag < 2; flag++) {
    field = own(186 + flag, 1);
    frames.push({
      ss: field.ss,
      es: field.es,
      protoId: 'sbus_futaba',
      kind: 'protocol',
      data: ['FLAG', [flag === 0 ? 'framelost' : 'failsafe', valueAt(message, 186 + flag, 1)]],
    });
  }
  field = own(188, 4);
  frames.push({
    ss: field.ss,
    es: field.es,
    protoId: 'sbus_futaba',
    kind: 'protocol',
    data: ['FLAG', ['msb', valueAt(message, 188, 4)]],
  });
  field = own(192, 8);
  frames.push({
    ss: field.ss,
    es: field.es,
    protoId: 'sbus_futaba',
    kind: 'protocol',
    data: ['FOOTER', valueAt(message, 192, 8)],
  });
  return frames;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53425553,
}: GenerationOptions = {}): Iterable<SbusCase> {
  const boundaries: readonly (readonly [string, SbusMessage])[] = [
    ['minimum-values', message(0x0f, Array(16).fill(0), [0, 0], 0, 0, 0)],
    ['maximum-values', message(0x0f, Array(16).fill(2047), [1, 1], 3, 0, 0, 'rx')],
    ['warnings', message(0x01, [0, 2047, ...Array(14).fill(1024)], [1, 0], 2, 15, 0xff)],
  ];
  for (const [name, item] of boundaries) {
    const startSample = name === 'maximum-values' ? 9_007_199_254_740_990n : 5n;
    yield {
      name,
      kind: 'boundary',
      seed,
      sampleRate: SAMPLE_RATE,
      startSample,
      channels: CHANNELS,
      options: { prop_val_min: name === 'warnings' ? 300 : 0, prop_val_max: name === 'warnings' ? 1800 : 2047 },
      chunkSamples: [1, 31, 257, 4093],
      minimumPayloadBits: 0,
      chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      *generate() {
        yield {
          data: [item],
          expected: expected(item, 2, startSample),
          payloadBits: 200,
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    perBlock = 128,
    count = Math.ceil(required / 200),
    blocks = Math.ceil(count / perBlock);
  let generated = 0;
  yield {
    name: 'seeded-long-messages',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: CHANNELS,
    options: { prop_val_min: 0, prop_val_max: 2047 },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const random = randomWords(seed);
      let frameStart = 2;
      for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
        const data: SbusMessage[] = [],
          frames: ExpectedFrame[] = [];
        for (let index = 0; index < perBlock && generated < count; index++, generated++) {
          const values = Array.from({ length: 16 }, () => random() & 0x7ff);
          const item = message(0x0f, values, [random() & 1, random() & 1], random() & 3, 0, 0, 'tx');
          data.push(item);
          frames.push(...expected(item, frameStart, 0n));
          frameStart += item.bytes.length * (FRAME_BITS + WITHIN_GAP) + BETWEEN_GAP;
        }
        yield { data, expected: frames, payloadBits: data.length * 200 };
      }
    },
  };
}
