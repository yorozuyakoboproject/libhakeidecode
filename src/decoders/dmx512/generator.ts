import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export interface DmxPacket {
  readonly bytes: readonly number[];
  readonly breakBits?: number;
  readonly mabBits?: number;
  readonly idleBits?: number;
}

export interface DmxCase extends RoundtripCase<DmxPacket> {}

export interface DmxTiming {
  readonly breakStartUnits: number;
  readonly breakEndUnits: number;
  readonly packetStartUnits: number;
  readonly packetEndUnits: number;
  readonly nextUnits: number;
}

export const DMX_LEAD_BITS = 8;
export const DMX_BREAK_BITS = 24;
export const DMX_MAB_BITS = 2;
export const DMX_IDLE_BITS = 8;
export const DMX_FRAME_BITS = 11;

const UART_OPTIONS = {
  baudrate: 250_000,
  data_bits: 8,
  parity: 'none',
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

const DMX_OPTIONS = {
  min_break: 88,
  max_mark: 1_000_000,
  min_break_break: 1196,
  max_reset_reset: 1_250_000,
  show_zero: 'yes',
  format: 'dec',
} as const;

export function dmxBitWidth(config: Pick<RoundtripCase<DmxPacket>, 'sampleRate' | 'chain'>): number {
  return config.sampleRate / Number(config.chain?.[0]?.options.baudrate ?? UART_OPTIONS.baudrate);
}

export function dmxSampleAt(
  config: Pick<RoundtripCase<DmxPacket>, 'startSample'>,
  units: number,
  bitWidth: number,
): bigint {
  return config.startSample + BigInt(Math.round(units * bitWidth));
}

export function locatePacket(startUnits: number, packet: DmxPacket): DmxTiming {
  const breakBits = packet.breakBits ?? DMX_BREAK_BITS;
  const mabBits = packet.mabBits ?? DMX_MAB_BITS;
  const idleBits = packet.idleBits ?? DMX_IDLE_BITS;
  const breakEndUnits = startUnits + breakBits;
  const packetStartUnits = breakEndUnits + mabBits;
  const packetEndUnits = packetStartUnits + packet.bytes.length * DMX_FRAME_BITS;
  return {
    breakStartUnits: startUnits,
    breakEndUnits,
    packetStartUnits,
    packetEndUnits,
    nextUnits: packetEndUnits + idleBits,
  };
}

function packetFrame(
  config: Pick<RoundtripCase<DmxPacket>, 'startSample' | 'sampleRate' | 'chain'>,
  packet: DmxPacket,
  timing: DmxTiming,
): ExpectedFrame {
  const bitWidth = dmxBitWidth(config);
  const data = packet.bytes.map((value, index) => {
    const start = timing.packetStartUnits + index * DMX_FRAME_BITS;
    return [
      dmxSampleAt(config, start, bitWidth),
      dmxSampleAt(config, start + DMX_FRAME_BITS, bitWidth),
      value,
      true,
    ] as const;
  });
  return {
    ss: data[0]![0],
    es: data[data.length - 1]![1],
    protoId: 'dmx512',
    kind: 'protocol',
    data: ['PACKET', data],
  };
}

function interval(
  config: Pick<RoundtripCase<DmxPacket>, 'startSample' | 'sampleRate' | 'chain'>,
  startUnits: number,
  endUnits: number,
): { ss: bigint; es: bigint } {
  const width = dmxBitWidth(config);
  return { ss: dmxSampleAt(config, startUnits, width), es: dmxSampleAt(config, endUnits, width) };
}

function options(overrides: Partial<Dmx512Options> = {}): Record<string, OptionValue> {
  return { ...DMX_OPTIONS, ...overrides };
}

interface Dmx512Options {
  readonly min_break: number;
  readonly max_mark: number;
  readonly min_break_break: number;
  readonly max_reset_reset: number;
  readonly show_zero: string;
  readonly format: string;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x444d5835,
}: GenerationOptions = {}): Iterable<DmxCase> {
  const boundaryPackets: DmxPacket[] = [
    { bytes: [0x00, 0x00, 0x01, 0xff], idleBits: 8 },
    { bytes: [0x17, 0x41, 0x42], idleBits: 8 },
  ];
  const boundaryStart = 11n;
  yield {
    name: 'start-code-channel-and-slot',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: boundaryStart,
    channels: { rx: 1 },
    options: options({ format: 'hex', show_zero: 'yes' }),
    chunkSamples: [1, 17, 127, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const config = {
        startSample: boundaryStart,
        sampleRate: 2_000_000,
        chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      };
      const timings: DmxTiming[] = [];
      let units = DMX_LEAD_BITS;
      for (const packet of boundaryPackets) {
        const timing = locatePacket(units, packet);
        timings.push(timing);
        units = timing.nextUnits;
      }
      const first = timings[0]!;
      const second = timings[1]!;
      const byte1 = first.packetStartUnits + DMX_FRAME_BITS;
      const secondByte1 = second.packetStartUnits + DMX_FRAME_BITS;
      yield {
        data: boundaryPackets,
        expected: [packetFrame(config, boundaryPackets[0]!, first), packetFrame(config, boundaryPackets[1]!, second)],
        expectedAnnotations: [
          { ...interval(config, first.breakStartUnits, first.breakEndUnits), classIndex: 0 },
          { ...interval(config, first.breakEndUnits, first.packetStartUnits), classIndex: 1 },
          {
            ...interval(config, first.packetStartUnits, first.packetStartUnits + DMX_FRAME_BITS),
            classIndex: 4,
          },
          {
            ...interval(config, first.breakStartUnits, first.packetStartUnits + DMX_FRAME_BITS),
            classIndex: 8,
          },
          { ...interval(config, byte1, byte1 + DMX_FRAME_BITS), classIndex: 5 },
          { ...interval(config, byte1, byte1 + DMX_FRAME_BITS), classIndex: 6 },
          { ...interval(config, first.packetEndUnits, second.breakStartUnits), classIndex: 3 },
          { ...interval(config, second.breakStartUnits, second.breakEndUnits), classIndex: 0 },
          { ...interval(config, second.breakEndUnits, second.packetStartUnits), classIndex: 1 },
          {
            ...interval(config, second.packetStartUnits, second.packetStartUnits + DMX_FRAME_BITS),
            classIndex: 4,
          },
          { ...interval(config, secondByte1, secondByte1 + DMX_FRAME_BITS), classIndex: 5 },
          { ...interval(config, secondByte1, secondByte1 + DMX_FRAME_BITS), classIndex: 7 },
        ],
        payloadBits: 6 * 8,
      };
    },
  };

  const warningPacket: DmxPacket = { bytes: [0x00, 0x2a], breakBits: 24, mabBits: 2, idleBits: 8 };
  const warningStart = 9_007_199_254_740_990n;
  yield {
    name: 'timing-warnings',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: warningStart,
    channels: { rx: 0 },
    options: options({ min_break: 200, max_mark: 1, show_zero: 'no' }),
    chunkSamples: [5, 31, 257, 4093],
    minimumPayloadBits: 0,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const config = {
        startSample: warningStart,
        sampleRate: 2_000_000,
        chain: [{ decoder: 'uart', options: UART_OPTIONS }],
      };
      const timing = locatePacket(DMX_LEAD_BITS, warningPacket);
      yield {
        data: [warningPacket],
        expected: [packetFrame(config, warningPacket, timing)],
        expectedAnnotations: [
          { ...interval(config, timing.breakStartUnits, timing.breakEndUnits), classIndex: 0 },
          { ...interval(config, timing.breakStartUnits, timing.breakEndUnits), classIndex: 9 },
          { ...interval(config, timing.breakEndUnits, timing.packetStartUnits), classIndex: 1 },
          { ...interval(config, timing.breakEndUnits, timing.packetStartUnits), classIndex: 10 },
          {
            ...interval(config, timing.packetStartUnits, timing.packetStartUnits + DMX_FRAME_BITS),
            classIndex: 4,
          },
          {
            ...interval(config, timing.breakStartUnits, timing.packetStartUnits + DMX_FRAME_BITS),
            classIndex: 8,
          },
        ],
        payloadBits: 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const slotsPerPacket = 512;
  const packetsPerBlock = 64;
  const bitsPerBlock = slotsPerPacket * 8 * packetsPerBlock;
  const blocks = Math.max(2, Math.ceil(required / bitsPerBlock));
  const sampleRate = 2_000_000;
  const chain = [{ decoder: 'uart', options: UART_OPTIONS }] as const;
  const span = locatePacket(0, { bytes: Array<number>(slotsPerPacket + 1).fill(0) }).nextUnits;
  yield {
    name: 'seeded-long-packets',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { rx: 3 },
    options: options({ show_zero: 'yes', format: 'dec' }),
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: [{ decoder: 'uart', options: UART_OPTIONS }],
    *generate() {
      const random = randomWords(seed);
      const config = { startSample: 0n, sampleRate, chain };
      for (let block = 0; block < blocks; block++) {
        const data: DmxPacket[] = [];
        const expected: ExpectedFrame[] = [];
        for (let index = 0; index < packetsPerBlock; index++) {
          const bytes = [0x00];
          for (let slot = 0; slot < slotsPerPacket; slot++) bytes.push(random() & 0xff);
          const packet: DmxPacket = { bytes, idleBits: DMX_IDLE_BITS };
          data.push(packet);
          const startUnits = DMX_LEAD_BITS + (block * packetsPerBlock + index) * span;
          expected.push(packetFrame(config, packet, locatePacket(startUnits, packet)));
        }
        yield { data, expected, payloadBits: bitsPerBlock };
      }
    },
  };
}
