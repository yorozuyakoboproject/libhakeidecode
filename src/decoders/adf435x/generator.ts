import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Adf435xFrame {
  readonly mosi: readonly number[];
  readonly bits?: number;
}

export interface Adf435xCase extends RoundtripCase<Adf435xFrame> {}

const channels = { clk: 3, miso: 0, mosi: 7, cs: 1 },
  REGISTER_COUNTS: readonly number[] = [3, 5, 14, 7, 11, 2];

function bytes32(value: number): number[] {
  return [
    Math.floor(value / 2 ** 24) & 0xff,
    Math.floor(value / 2 ** 16) & 0xff,
    Math.floor(value / 2 ** 8) & 0xff,
    value & 0xff,
  ];
}

function pack(register: number, fields: readonly (readonly [number, number, number])[]): number {
  let value = register;
  for (const [offset, width, field] of fields) {
    const max = 2 ** width;
    value += (field % max) * 2 ** offset;
  }
  return value;
}

function registerFrame(register: number): ExpectedFrame {
  return {
    classIndex: 0,
    texts: [`Register: ${register}`, `Reg: ${register}`, `[${register}]`],
  };
}

function fieldFrame(text: string): ExpectedFrame {
  return { classIndex: 0, texts: [text] };
}

function warningFrame(text: string): ExpectedFrame {
  return { classIndex: 1, texts: [text] };
}

function summary(): ExpectedFrame {
  return { protoId: 'adf435x', kind: 'summary' };
}

function spiOptions(wordsize: number, bitorder = 'msb-first') {
  return { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder, wordsize };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0xadf435,
}: GenerationOptions = {}): Iterable<Adf435xCase> {
  const boundaryValues = [
      pack(0, [
        [3, 12, 0],
        [15, 16, 23],
      ]),
      pack(0, [
        [3, 12, 0],
        [15, 16, 22],
      ]),
      pack(1, [
        [3, 12, 0xfff],
        [15, 12, 0xfff],
        [27, 1, 1],
        [28, 1, 1],
      ]),
      pack(2, [
        [3, 1, 1],
        [4, 1, 1],
        [5, 1, 1],
        [6, 1, 1],
        [7, 1, 1],
        [8, 1, 1],
        [9, 4, 15],
        [13, 1, 1],
        [14, 10, 0x3ff],
        [24, 1, 1],
        [25, 1, 1],
        [26, 3, 7],
        [29, 2, 3],
      ]),
      pack(3, [
        [3, 12, 0xfff],
        [15, 2, 3],
        [18, 1, 1],
        [21, 1, 1],
        [22, 1, 1],
        [23, 1, 1],
      ]),
      pack(4, [
        [3, 2, 3],
        [5, 1, 1],
        [6, 2, 3],
        [8, 1, 1],
        [9, 1, 1],
        [10, 1, 1],
        [11, 1, 1],
        [12, 8, 0xff],
        [20, 3, 7],
        [23, 1, 1],
      ]),
      pack(5, [[22, 2, 3]]),
      6,
    ],
    expectedAnnotations = [
      registerFrame(0),
      fieldFrame('FRAC: 0'),
      fieldFrame('INT: 23'),
      registerFrame(0),
      fieldFrame('FRAC: 0'),
      fieldFrame('INT: 22'),
      warningFrame('Not Allowed'),
      registerFrame(1),
      fieldFrame('MOD: 4095'),
      fieldFrame('Phase: 4095'),
      fieldFrame('Prescalar: 8/9'),
      fieldFrame('Phase Adjust: On'),
      registerFrame(2),
      fieldFrame('Counter Reset: Enabled'),
      fieldFrame('Charge Pump Three-State: Enabled'),
      fieldFrame('Power-Down: Enabled'),
      fieldFrame('PD Polarity: Positive'),
      fieldFrame('LDP: 6ns'),
      fieldFrame('LDF: INT-N'),
      fieldFrame('Charge Pump Current Setting: 5.00mA @ 5.1kΩ'),
      fieldFrame('Double Buffer: Enabled'),
      fieldFrame('R Counter: 1023'),
      fieldFrame('RDIV2: Enabled'),
      fieldFrame('Reference Doubler: Enabled'),
      fieldFrame('MUXOUT: Reserved'),
      fieldFrame('Low Noise and Low Spur Modes: Low Spur Mode'),
      registerFrame(3),
      fieldFrame('Clock Divider: 4095'),
      fieldFrame('Clock Divider Mode: Reserved'),
      fieldFrame('CSR Enable: Enabled'),
      fieldFrame('Charge Cancellation: Enabled'),
      fieldFrame('ABP: 3ns (INT-N)'),
      fieldFrame('Band Select Clock Mode: High'),
      registerFrame(4),
      fieldFrame('Output Power: +5dBm'),
      fieldFrame('Output Enable: Enabled'),
      fieldFrame('AUX Output Power: +5dBm'),
      fieldFrame('AUX Output Select: Fundamental'),
      fieldFrame('AUX Output Enable: Enabled'),
      fieldFrame('MTLD: Enabled'),
      fieldFrame('VCO Power-Down: VCO Powered Down'),
      fieldFrame('Band Select Clock Divider: 255'),
      fieldFrame('RF Divider Select: ÷128'),
      fieldFrame('Feedback Select: Fundamental'),
      registerFrame(5),
      fieldFrame('LD Pin Mode: High'),
      registerFrame(6),
    ];
  yield {
    name: 'register-boundaries',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 37n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = boundaryValues.map((value) => ({ mosi: bytes32(value) }));
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 32,
      };
    },
  };

  const errorValue = pack(0, [
      [3, 12, 0xabc],
      [15, 16, 23],
    ]),
    validValue = pack(0, [
      [3, 12, 0xabc],
      [15, 16, 23],
    ]);
  yield {
    name: 'frame-error',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 41n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [2, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data: Adf435xFrame[] = [
          { mosi: [0x12, 0x34, 0x56] },
          { mosi: bytes32(errorValue) },
          { mosi: bytes32(validValue) },
        ],
        expectedAnnotations = [
          {
            classIndex: 1,
            texts: ['Frame error: Bit count: want 32, got 24', 'Frame error: Bit count', 'Frame error'],
          },
          registerFrame(0),
          fieldFrame('FRAC: 2748'),
          fieldFrame('INT: 23'),
          registerFrame(0),
          fieldFrame('FRAC: 2748'),
          fieldFrame('INT: 23'),
        ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: 24 + 32 + 32,
      };
    },
  };

  const multiValues = [
    pack(0, [
      [3, 12, 0xabc],
      [15, 16, 0x7fff],
    ]),
    pack(1, [
      [3, 12, 0xabc],
      [15, 12, 0xdef],
      [27, 1, 1],
      [28, 1, 1],
    ]),
  ];
  yield {
    name: 'multi-byte-word',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(32) }],
    chunkSamples: [4093, 8191],
    minimumPayloadBits: 0,
    *generate() {
      const data = multiValues.map((value) => ({ mosi: bytes32(value) })),
        expectedAnnotations = [
          registerFrame(0),
          fieldFrame('FRAC: 2748'),
          fieldFrame('INT: 32767'),
          registerFrame(1),
          fieldFrame('MOD: 2748'),
          fieldFrame('Phase: 3567'),
          fieldFrame('Prescalar: 8/9'),
          fieldFrame('Phase Adjust: On'),
        ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 32,
      };
    },
  };

  const lsbValue = pack(1, [
    [3, 12, 0x123],
    [15, 12, 0x456],
    [27, 1, 0],
    [28, 1, 1],
  ]);
  yield {
    name: 'lsb-first-byte-words',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 43n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8, 'lsb-first') }],
    chunkSamples: [3, 17, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data = [{ mosi: bytes32(lsbValue) }],
        expectedAnnotations = [
          registerFrame(1),
          fieldFrame('MOD: 291'),
          fieldFrame('Phase: 1110'),
          fieldFrame('Prescalar: 4/5'),
          fieldFrame('Phase Adjust: On'),
        ];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: 32,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits),
    totalFrames = Math.ceil(required / 32),
    framesPerBlock = 4096,
    blocks = Math.ceil(totalFrames / framesPerBlock);
  yield {
    name: 'seeded-long',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels,
    options: {},
    chain: [{ decoder: 'spi', options: spiOptions(8) }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(framesPerBlock, totalFrames - block * framesPerBlock),
          register = block % REGISTER_COUNTS.length,
          data: Adf435xFrame[] = [],
          expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const value =
            register === 0
              ? pack(0, [
                  [3, 12, random() & 0xfff],
                  [15, 16, 23 + (random() % (65536 - 23))],
                ])
              : Math.floor(random() / 8) * 8 + register;
          data.push({ mosi: bytes32(value) });
          if (index === 0 || index === count - 1) expectedAnnotations.push(registerFrame(register));
        }
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations,
          annotationCount: data.length * REGISTER_COUNTS[register]!,
          payloadBits: data.length * 32,
        };
      }
    },
  };
}
