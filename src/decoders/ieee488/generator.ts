import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export type Ieee488Step =
  | { readonly kind: 'parallel-byte'; readonly value: number; readonly atn: 0 | 1; readonly eoi: 0 | 1 }
  | {
      readonly kind: 'parallel-state';
      readonly atn: 0 | 1;
      readonly eoi: 0 | 1;
      readonly ifc: 0 | 1;
      readonly dio: number;
    }
  | { readonly kind: 'serial-byte'; readonly value: number; readonly atn: 0 | 1; readonly eoi: 0 | 1 }
  | { readonly kind: 'serial-state'; readonly atn: 0 | 1; readonly data: 0 | 1; readonly clk: 0 | 1 };

export interface Ieee488Case extends RoundtripCase<Ieee488Step> {}

const PARALLEL_CHANNELS = {
  dio1: 0,
  dio2: 1,
  dio3: 2,
  dio4: 3,
  dio5: 4,
  dio6: 5,
  dio7: 6,
  dio8: 7,
  eoi: 8,
  dav: 9,
  nrfd: 10,
  ndac: 11,
  ifc: 12,
  srq: 13,
  atn: 14,
  ren: 15,
} as const;

const SERIAL_CHANNELS = {
  dio1: 0,
  atn: 14,
  clk: 16,
} as const;

const SAMPLE_RATE = 2_000_000;

function packet(ptype: string, addr: number | null, pdata: unknown): ExpectedFrame {
  return { protoId: 'ieee488', kind: 'protocol', data: [ptype, addr, pdata] };
}

function annotation(classIndex: number, ...texts: string[]): ExpectedFrame {
  return { classIndex, texts };
}

function repeatedFrames(count: number): ExpectedFrame[] {
  return Array.from({ length: count }, () => ({ protoId: 'ieee488', kind: 'protocol' }));
}

function serialFrames(value: number, extra: ExpectedFrame[]): ExpectedFrame[] {
  const bits: ExpectedFrame[] = Array.from({ length: 8 }, (_, index) => ({
    protoId: 'ieee488',
    kind: 'protocol',
    data: ['IEC_BIT', null, (value >>> index) & 1],
  }));
  return bits.concat(extra);
}

function parallelBoundary(): Ieee488Case {
  const steps: Ieee488Step[] = [
    { kind: 'parallel-state', atn: 1, eoi: 0, ifc: 0, dio: 0 },
    { kind: 'parallel-byte', value: 0x3f, atn: 1, eoi: 0 },
    { kind: 'parallel-byte', value: 0x40, atn: 1, eoi: 0 },
    { kind: 'parallel-byte', value: 0x20, atn: 1, eoi: 0 },
    { kind: 'parallel-byte', value: 0x60, atn: 1, eoi: 0 },
    { kind: 'parallel-state', atn: 0, eoi: 0, ifc: 0, dio: 0 },
    { kind: 'parallel-byte', value: 0x41, atn: 0, eoi: 0 },
    { kind: 'parallel-byte', value: 0x42, atn: 0, eoi: 0 },
    { kind: 'parallel-state', atn: 0, eoi: 1, ifc: 0, dio: 0 },
    { kind: 'parallel-byte', value: 0x43, atn: 0, eoi: 1 },
    { kind: 'parallel-state', atn: 0, eoi: 0, ifc: 0, dio: 0 },
    { kind: 'parallel-state', atn: 1, eoi: 0, ifc: 0, dio: 0 },
    { kind: 'parallel-byte', value: 0x18, atn: 1, eoi: 0 },
    { kind: 'parallel-state', atn: 1, eoi: 1, ifc: 0, dio: 0x05 },
    { kind: 'parallel-state', atn: 1, eoi: 0, ifc: 0, dio: 0 },
    { kind: 'parallel-state', atn: 1, eoi: 0, ifc: 1, dio: 0 },
    { kind: 'parallel-state', atn: 1, eoi: 0, ifc: 0, dio: 0 },
  ];
  const frames = [
    packet('GPIB_RAW', null, 0x13f),
    packet('COMMAND', null, 0x3f),
    packet('TALK_LISTEN', null, []),
    packet('GPIB_RAW', null, 0x140),
    packet('TALK', 0, 0x40),
    packet('TALK_LISTEN', 0, []),
    packet('GPIB_RAW', null, 0x120),
    packet('LISTEN', 0, 0x20),
    packet('TALK_LISTEN', 0, [0]),
    packet('GPIB_RAW', null, 0x160),
    packet('SECONDARY', 0, 0x60),
    packet('GPIB_RAW', null, 0x41),
    packet('DATA_BYTE', 0, 0x41),
    packet('GPIB_RAW', null, 0x42),
    packet('DATA_BYTE', 0, 0x42),
    packet('GPIB_RAW', null, 0x43),
    packet('DATA_BYTE', 0, 0x43),
    packet('TALKER_BYTES', 0, Uint8Array.of(0x41, 0x42, 0x43)),
    packet('TALKER_TEXT', 0, 'ABC'),
    packet('GPIB_RAW', null, 0x118),
    packet('COMMAND', null, 0x18),
    packet('PPOLL', null, [0, 2]),
  ];
  return {
    name: 'parallel-command-data-eoi-and-parallel-poll',
    kind: 'boundary',
    seed: 0x49454545,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: PARALLEL_CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: steps,
        expected: frames,
        expectedAnnotations: [
          annotation(2, 'Unlisten', 'UNL'),
          annotation(4, 'Talk 0', 'T 0', 'T0'),
          annotation(3, 'Listen 0', 'L 0', 'L0'),
          annotation(5, 'Secondary 0', 'S 0', 'S0'),
          annotation(6, 'A'),
          annotation(6, 'B'),
          annotation(6, 'C'),
          annotation(7, 'EOI'),
          annotation(9, 'ABC'),
          annotation(2, 'Serial Poll Enable', 'SPE'),
          annotation(8, 'PPOLL DIO1 DIO3', 'PP 1 3', 'PP'),
        ],
        payloadBits: 8 * 8,
      };
    },
  };
}

function serialBoundary(): Ieee488Case {
  const steps: Ieee488Step[] = [
    { kind: 'serial-state', atn: 1, data: 1, clk: 1 },
    { kind: 'serial-byte', value: 0x3f, atn: 1, eoi: 0 },
    { kind: 'serial-byte', value: 0x40, atn: 1, eoi: 0 },
    { kind: 'serial-byte', value: 0x28, atn: 1, eoi: 0 },
    { kind: 'serial-byte', value: 0xf0, atn: 1, eoi: 0 },
    { kind: 'serial-state', atn: 0, data: 1, clk: 1 },
    { kind: 'serial-byte', value: 0x68, atn: 0, eoi: 0 },
    { kind: 'serial-byte', value: 0x69, atn: 0, eoi: 1 },
  ];
  const frames = [
    ...serialFrames(0x3f, [
      packet('GPIB_RAW', null, 0x13f),
      packet('COMMAND', null, 0x3f),
      packet('TALK_LISTEN', null, []),
    ]),
    ...serialFrames(0x40, [packet('GPIB_RAW', null, 0x140), packet('TALK', 0, 0x40), packet('TALK_LISTEN', 0, [])]),
    ...serialFrames(0x28, [packet('GPIB_RAW', null, 0x128), packet('LISTEN', 8, 0x28), packet('TALK_LISTEN', 0, [8])]),
    ...serialFrames(0xf0, [packet('GPIB_RAW', null, 0x1f0), packet('MSB_SET', 0xf0, 0xf0)]),
    ...serialFrames(0x68, [packet('GPIB_RAW', null, 0x68), packet('DATA_BYTE', 0, 0x68)]),
    ...serialFrames(0x69, [
      packet('GPIB_RAW', null, 0x69),
      packet('DATA_BYTE', 0, 0x69),
      packet('TALKER_BYTES', 0, Uint8Array.of(0x68, 0x69)),
      packet('TALKER_TEXT', 0, 'hi'),
    ]),
  ];
  return {
    name: 'serial-atn-address-eoi-and-iec-peripheral',
    kind: 'boundary',
    seed: 0x494543,
    sampleRate: SAMPLE_RATE,
    startSample: 37n,
    channels: SERIAL_CHANNELS,
    options: { iec_periph: 'yes' },
    chunkSamples: [1, 3, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: steps,
        expected: frames,
        expectedAnnotations: [
          annotation(0, '1'),
          annotation(2, 'Unlisten', 'UNL'),
          annotation(4, 'Talk 0', 'T 0', 'T0'),
          annotation(3, 'Listen 8', 'L 8', 'L8'),
          annotation(10, 'Disk 0'),
          annotation(5, 'Secondary 240', 'S 240', `S${String.fromCharCode(48 + 240)}`),
          annotation(10, 'Open 0', 'Op 0', 'O0'),
          annotation(6, 'h'),
          annotation(6, 'i'),
          annotation(7, 'EOI'),
          annotation(9, 'hi'),
        ],
        payloadBits: 6 * 8,
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x49454545,
}: GenerationOptions = {}): Iterable<Ieee488Case> {
  yield parallelBoundary();
  yield serialBoundary();

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerBlock = 2048;
  const payloadPerBlock = bytesPerBlock * 8;
  const blocks = Math.ceil(required / payloadPerBlock);
  yield {
    name: 'seeded-long-parallel-data',
    kind: 'long',
    seed,
    sampleRate: SAMPLE_RATE,
    startSample: 0n,
    channels: PARALLEL_CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const data: Ieee488Step[] = [];
        for (let index = 0; index < bytesPerBlock; index++) {
          const value = index === 0 ? 0x78 : 0x20 + (random() % 95);
          data.push({ kind: 'parallel-byte', value, atn: 0, eoi: 0 });
        }
        const frames = repeatedFrames(bytesPerBlock * 2);
        frames[0] = packet('GPIB_RAW', null, 0x78);
        frames[1] = packet('DATA_BYTE', null, 0x78);
        yield {
          data,
          expected: frames,
          expectedAnnotations: [annotation(6, 'x')],
          payloadBits: payloadPerBlock,
        };
      }
      yield {
        data: [
          { kind: 'parallel-byte', value: 0x78, atn: 0, eoi: 0 },
          { kind: 'parallel-state', atn: 1, eoi: 0, ifc: 0, dio: 0 },
        ],
        expected: repeatedFrames(4),
        expectedAnnotations: [annotation(6, 'x')],
        payloadBits: 8,
      };
    },
  };
}
