import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface NesGamepadCase extends RoundtripCase<number> {
  readonly initialSamples: number;
}

const CHANNELS = { clk: 2, miso: 5 } as const;
const CHAIN = [
  {
    decoder: 'spi',
    options: {
      cs_polarity: 'active-low',
      cpol: 1,
      cpha: 0,
      bitorder: 'msb-first',
      wordsize: 8,
    },
  },
] as const;
const BUTTONS = ['A', 'B', 'Select', 'Start', 'North', 'South', 'West', 'East'];

function annotation(value: number, index: number, start: bigint, initialSamples: number): ExpectedFrame {
  const ss = start + BigInt(initialSamples + 16 * index);
  const es = ss + 14n;
  if (value === 0xff) return { ss, es, classIndex: 1, texts: ['No button is pressed'] };
  if (value === 0x00) return { ss, es, classIndex: 2, texts: ['Gamepad is not connected'] };
  const pressed = BUTTONS.filter((_, bit) => ((value >>> (7 - bit)) & 1) === 0);
  return {
    ss,
    es,
    classIndex: 0,
    texts: [pressed.join(' + ')],
  };
}

function summary(): ExpectedFrame {
  return { protoId: 'nes_gamepad', kind: 'summary' };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4e4553,
}: GenerationOptions = {}): Iterable<NesGamepadCase> {
  yield {
    name: 'special-and-mixed-buttons',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 13n,
    channels: CHANNELS,
    options: { variant: 'Standard gamepad' },
    chunkSamples: [1, 17, 257, 4093],
    minimumPayloadBits: 0,
    initialSamples: 2,
    chain: CHAIN,
    *generate() {
      const data = [0xff, 0x00, 0xfe, 0x01, 0xaa, 0x55, 0x7f, 0x80];
      yield {
        data,
        expected: [summary()],
        expectedAnnotations: data.map((value, index) =>
          annotation(value, index, this.startSample, this.initialSamples),
        ),
        annotationCount: data.length,
        payloadBits: data.length * 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bytesPerBlock = 8192;
  const total = Math.ceil(required / 8);
  const blocks = Math.ceil(total / bytesPerBlock);
  yield {
    name: 'seeded-long-gamepad-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: { clk: 0, miso: 3 },
    options: { variant: 'Standard gamepad' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    initialSamples: 2,
    chain: CHAIN,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(bytesPerBlock, total - block * bytesPerBlock);
        const data = Array.from({ length: count }, () => random() & 0xff);
        const firstIndex = block * bytesPerBlock;
        yield {
          data,
          expected: block === 0 ? [summary()] : [],
          expectedAnnotations: [
            annotation(data[0]!, firstIndex, this.startSample, this.initialSamples),
            annotation(data[count - 1]!, firstIndex + count - 1, this.startSample, this.initialSamples),
          ],
          annotationCount: count,
          payloadBits: count * 8,
        };
      }
    },
  };
}
