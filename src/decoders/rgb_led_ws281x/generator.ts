import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface WsPixel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly w?: number;
}

export interface Ws281xCase extends RoundtripCase<WsPixel> {
  readonly bitTiming?: {
    readonly zeroHigh: number;
    readonly oneHigh: number;
    readonly period: number;
  };
}

const SUMMARY: ExpectedFrame = { protoId: 'rgb_led_ws281x', kind: 'summary' };

function components(wireorder: string, pixel: WsPixel): readonly [string, number][] {
  return [...wireorder.toLowerCase()].map((name) => {
    const value = name === 'r' ? pixel.r : name === 'g' ? pixel.g : name === 'b' ? pixel.b : (pixel.w ?? 0);
    return [name, value & 0xff];
  });
}

function pixelAnnotations(wireorder: string, textorder: string, pixel: WsPixel): ExpectedFrame[] {
  const values = components(wireorder, pixel);
  const result: ExpectedFrame[] = values.map(([name, value]) => ({
    classIndex: name === 'r' ? 3 : name === 'g' ? 4 : name === 'b' ? 5 : 6,
    texts: [value.toString(16).padStart(2, '0')],
  }));
  const red = pixel.r & 0xff,
    green = pixel.g & 0xff,
    blue = pixel.b & 0xff,
    white = (pixel.w ?? 0) & 0xff;
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  const byName: Record<string, string> = { r: hex(red), g: hex(green), b: hex(blue), w: hex(white) };
  let text: string;
  if (textorder === 'wire') text = '#' + values.map(([name]) => byName[name]).join('');
  else if (textorder === 'RGB[W]')
    text = `#${hex(red)}${hex(green)}${hex(blue)}${pixel.w === undefined ? '' : hex(white)}`;
  else if (textorder === 'RGBW') text = `#${hex(red)}${hex(green)}${hex(blue)}${hex(white)}`;
  else if (textorder === 'RGWB') text = `#${hex(red)}${hex(green)}${hex(white)}${hex(blue)}`;
  else if (textorder === 'BGR') text = `#${hex(blue)}${hex(green)}${hex(red)}`;
  else if (textorder === 'BRG') text = `#${hex(blue)}${hex(red)}${hex(green)}`;
  else if (textorder === 'GBR') text = `#${hex(green)}${hex(blue)}${hex(red)}`;
  else if (textorder === 'GRB') text = `#${hex(green)}${hex(red)}${hex(blue)}`;
  else if (textorder === 'RBG') text = `#${hex(red)}${hex(blue)}${hex(green)}`;
  else text = `#${hex(red)}${hex(green)}${hex(blue)}`;
  result.push({ classIndex: 2, texts: [text] });
  return result;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x57533238,
}: GenerationOptions = {}): Iterable<Ws281xCase> {
  const boundaryPixels: WsPixel[] = [
    { r: 0x00, g: 0x00, b: 0x00 },
    { r: 0xff, g: 0xff, b: 0xff },
    { r: 0x12, g: 0x34, b: 0x56 },
  ];
  yield {
    name: 'rgb-grb-default',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 9_007_199_254_740_990n,
    channels: { din: 3 },
    options: { wireorder: 'GRB', textorder: 'RGB[W]' },
    chunkSamples: [1, 7, 31, 257],
    minimumPayloadBits: 0,
    *generate() {
      const first = pixelAnnotations('GRB', 'RGB[W]', boundaryPixels[0]!);
      yield {
        data: boundaryPixels,
        expected: [SUMMARY],
        expectedAnnotations: first,
        annotationCount: boundaryPixels.length * 28 + 1,
        payloadBits: boundaryPixels.length * 24,
      };
    },
  };
  yield {
    name: 'short-high-pulse-first-and-later-bits',
    kind: 'boundary',
    seed,
    sampleRate: 5_000_000,
    startSample: 41n,
    channels: { din: 3 },
    options: { wireorder: 'GRB', textorder: 'RGB[W]' },
    chunkSamples: [1, 7, 31],
    bitTiming: { zeroHigh: 2, oneHigh: 3, period: 8 },
    minimumPayloadBits: 0,
    *generate() {
      const pixel = { r: 0x80, g: 0x80, b: 0x01 };
      yield {
        data: [pixel],
        expected: [SUMMARY],
        expectedAnnotations: pixelAnnotations('GRB', 'RGB[W]', pixel),
        annotationCount: 29,
        payloadBits: 24,
      };
    },
  };
  yield {
    name: 'rgbw-white-components',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 21n,
    channels: { din: 0 },
    options: { wireorder: 'RGBW', textorder: 'RGBW' },
    chunkSamples: [3, 17, 513],
    minimumPayloadBits: 0,
    *generate() {
      const pixel = { r: 0x01, g: 0x23, b: 0x45, w: 0x67 };
      yield {
        data: [pixel],
        expected: [SUMMARY],
        expectedAnnotations: pixelAnnotations('RGBW', 'RGBW', pixel),
        annotationCount: 38,
        payloadBits: 32,
      };
    },
  };
  yield {
    name: 'wire-text-order',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 31n,
    channels: { din: 5 },
    options: { wireorder: 'BGR', textorder: 'wire' },
    chunkSamples: [7, 127],
    minimumPayloadBits: 0,
    *generate() {
      const pixel = { r: 0xaa, g: 0xbb, b: 0xcc };
      yield {
        data: [pixel],
        expected: [SUMMARY],
        expectedAnnotations: pixelAnnotations('BGR', 'wire', pixel),
        annotationCount: 29,
        payloadBits: 24,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const pixels = Math.ceil(required / 24);
  const firstBlock = Math.ceil(pixels / 2);
  yield {
    name: 'seeded-long-rgb-stream',
    kind: 'long',
    seed,
    sampleRate: 4_000_000,
    startSample: 0n,
    channels: { din: 0 },
    options: { wireorder: 'GRB', textorder: 'RGB[W]' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      for (let block = 0; block < 2; block++) {
        const count = block === 0 ? firstBlock : pixels - firstBlock;
        const data = Array.from({ length: count }, (): WsPixel => ({
          r: random() & 0xff,
          g: random() & 0xff,
          b: random() & 0xff,
        }));
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: pixelAnnotations('GRB', 'RGB[W]', data[0]!),
          annotationCount: data.length * 28 + 1,
          payloadBits: data.length * 24,
        };
      }
    },
  };
}
