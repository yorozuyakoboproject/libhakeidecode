import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface St25Word {
  readonly mosi: number;
  readonly miso: number;
}

export interface St25Frame {
  readonly words: readonly St25Word[];
}

export interface St25Case extends RoundtripCase<St25Frame> {}

export const ST25_CHAIN = [
  {
    decoder: 'spi',
    options: { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 },
  },
] as const;

export const ST25_CHANNELS = { clk: 1, mosi: 4, miso: 7, cs: 2 } as const;
export const ST25_SAMPLE_RATE = 4_000_000;

function frame(...bytes: readonly number[]): St25Frame {
  return { words: bytes.map((mosi) => ({ mosi, miso: 0 })) };
}

function words(items: readonly (readonly [number, number])[]): St25Frame {
  return { words: items.map(([mosi, miso]) => ({ mosi, miso })) };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53543235,
}: GenerationOptions = {}): Iterable<St25Case> {
  const boundaries: readonly {
    name: string;
    data: readonly St25Frame[];
    annotations: readonly ExpectedFrame[];
    count: number;
  }[] = [
    {
      name: 'direct-commands',
      data: [frame(0xc4), frame(0xdb), frame(0xe8)],
      annotations: [
        { classIndex: 6, texts: ['Cmd TXCRC'] },
        { classIndex: 6, texts: ['Cmd CLRFIFO'] },
        { classIndex: 6, texts: ['Cmd STOPNRESTIM'] },
      ],
      count: 3,
    },
    {
      name: 'register-write',
      data: [frame(0x00, 0x12, 0x34)],
      annotations: [{ classIndex: 1, texts: ['Write: IOCFG1 (00) = 12 34'] }],
      count: 1,
    },
    {
      name: 'register-read',
      data: [
        words([
          [0x40, 0x00],
          [0x00, 0x12],
          [0x00, 0x34],
        ]),
      ],
      annotations: [{ classIndex: 0, texts: ['Read: IOCFG1 (00) = 12 34'] }],
      count: 1,
    },
    {
      name: 'space-b-write',
      data: [frame(0xfb, 0x05, 0xaa)],
      annotations: [{ classIndex: 3, texts: ['WriteB: EMDSUPPRCONF (05) = AA'] }],
      count: 1,
    },
    {
      name: 'fifo-write',
      data: [frame(0x80, 0x01, 0x02, 0x03)],
      annotations: [{ classIndex: 7, texts: ['FIFOW: 01 02 03'] }],
      count: 1,
    },
    {
      name: 'unknown-command',
      data: [frame(0xff)],
      annotations: [{ classIndex: 10, texts: ['Unknown command'] }],
      count: 1,
    },
  ];

  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: ST25_SAMPLE_RATE,
      startSample: item.name === 'register-read' ? 9_007_199_254_740_990n : 5n,
      channels: ST25_CHANNELS,
      options: {},
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
      chain: ST25_CHAIN,
      *generate() {
        yield {
          data: item.data,
          expected: [{ protoId: 'st25r39xx_spi', kind: 'summary' }],
          expectedAnnotations: item.annotations,
          annotationCount: item.count,
          payloadBits: item.data.reduce((sum, current) => sum + current.words.length * 8, 0),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const count = Math.ceil(required / 8);
  const perBlock = 4096;
  yield {
    name: 'seeded-long-direct-commands',
    kind: 'long',
    seed,
    sampleRate: ST25_SAMPLE_RATE,
    startSample: 0n,
    channels: ST25_CHANNELS,
    options: {},
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    chain: ST25_CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < count; offset += perBlock) {
        const length = Math.min(perBlock, count - offset);
        const data = Array.from({ length }, () => ({
          words: [{ mosi: 0xc4, miso: random() & 0xff }],
        }));
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'st25r39xx_spi', kind: 'summary' }] : [],
          expectedAnnotations:
            offset === 0 ? [{ classIndex: 6, texts: ['Cmd TXCRC'] }] : [{ classIndex: 6, texts: ['Cmd TXCRC'] }],
          annotationCount: data.length,
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
