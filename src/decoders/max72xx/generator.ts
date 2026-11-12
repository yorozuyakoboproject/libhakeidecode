import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface Max72xxCase extends RoundtripCase<number> {}

const CHANNELS = { clk: 3, mosi: 7, cs: 1 };
const SUMMARY: ExpectedFrame = { protoId: 'max72xx', kind: 'summary' };
const SPI = { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 } as const;

function command(register: number, value: number): ExpectedFrame[] {
  let text: string;
  let classIndex: number;
  if (register >= 1 && register <= 8) text = `Digit ${register}: ${value.toString(16).toUpperCase().padStart(2, '0')}`;
  else if (register === 0x09) text = `Decode: 0b${value.toString(2).padStart(8, '0')}`;
  else if (register === 0x0a) {
    const intensity = value & 0x0f;
    text = `Intensity: ${intensity === 0 ? 'min' : intensity === 15 ? 'max' : intensity}`;
  } else if (register === 0x0b) text = `Scan limit: ${1 + value}`;
  else if (register === 0x0c) text = `Shutdown: ${value ? 'off' : 'on'}`;
  else if (register === 0x0f) text = `Display test: ${value ? 'on' : 'off'}`;
  else text = `Unknown register ${register.toString(16).toUpperCase().padStart(2, '0')}`;
  if (register === 0x00) text = value ? 'No-op: ' : 'No-op';
  classIndex =
    register >= 1 && register <= 8
      ? 2
      : register === 0x00 ||
          register === 0x09 ||
          register === 0x0a ||
          register === 0x0b ||
          register === 0x0c ||
          register === 0x0f
        ? 1
        : 3;
  return [{ classIndex, texts: [text] }];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d415837,
}: GenerationOptions = {}): Iterable<Max72xxCase> {
  yield {
    name: 'three-driver-commands',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: { numofdrivers: 3 },
    chain: [{ decoder: 'spi', options: SPI }],
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = [0x09, 0xff, 0x0a, 0x0f, 0x01, 0x5a, 0x10, 0x00, 0x00, 0x01, 0x0c, 0x00];
      const expectedAnnotations: ExpectedFrame[] = [];
      for (let index = 0; index < data.length; index += 2) {
        expectedAnnotations.push({ classIndex: 0, texts: [`Chip ${(index % 6) / 2 + 1}`] });
        expectedAnnotations.push(...command(data[index]!, data[index + 1]!));
      }
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 8,
      };
    },
  };

  yield {
    name: 'partial-chip-select',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_900n,
    channels: CHANNELS,
    options: { numofdrivers: 2 },
    chain: [{ decoder: 'spi', options: SPI }],
    chunkSamples: [3, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data = [0x01];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: [{ classIndex: 3, texts: ['Not enough bits sent for current number of chips'] }],
        annotationCount: 1,
        payloadBits: 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalBytes = Math.ceil(required / 8);
  const perBlock = 4096;
  yield {
    name: 'seeded-long-digit-writes',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: { numofdrivers: 1 },
    chain: [{ decoder: 'spi', options: SPI }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < totalBytes; offset += perBlock) {
        const count = Math.min(perBlock, totalBytes - offset);
        const data: number[] = [];
        for (let index = 0; index < count; index += 2) {
          data.push(1 + (random() % 8), random() & 0xff);
        }
        const expectedAnnotations: ExpectedFrame[] = [];
        for (let index = 0; index < Math.min(2, data.length); index += 2)
          expectedAnnotations.push(...command(data[index]!, data[index + 1]!));
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: data.length / 2,
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
