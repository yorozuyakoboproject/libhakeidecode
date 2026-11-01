import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface WS2812Pixel {
  readonly kind: 'pixel';
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly w?: number;
}
export interface WS2812Reset {
  readonly kind: 'reset';
}
export interface WS2812Partial {
  readonly kind: 'partial';
  readonly bits: readonly number[];
}
export type WS2812Item = WS2812Pixel | WS2812Reset | WS2812Partial;
export interface WS2812Case extends RoundtripCase<WS2812Item> {
  readonly timingSkew: number;
}

export function textFor(pixel: WS2812Pixel, order: string): string {
  const values = { R: pixel.r, G: pixel.g, B: pixel.b, W: pixel.w ?? 0 },
    hasWhite = pixel.w !== undefined;
  let textOrder = order
    .split('')
    .filter((channel) => hasWhite || channel !== 'W')
    .join('');
  if (hasWhite && !textOrder.includes('W')) textOrder += 'W';
  return textOrder
    .split('')
    .map(
      (channel) =>
        channel + ':0x' + values[channel as 'R' | 'G' | 'B' | 'W'].toString(16).padStart(2, '0').toUpperCase(),
    )
    .join(' ');
}

function expected(pixel: WS2812Pixel, index: number, order: string): ExpectedFrame {
  return {
    index,
    r: pixel.r,
    g: pixel.g,
    b: pixel.b,
    w: pixel.w ?? null,
    text: textFor(pixel, order),
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x57533238,
}: GenerationOptions = {}): Iterable<WS2812Case> {
  const boundaries = [
    { name: 'grb-rgb-reset', wire: 'GRB', text: 'RGB', white: false, reset: true, skew: 0, partial: true },
    { name: 'brg-grb-skew', wire: 'BRG', text: 'GRB', white: false, reset: false, skew: 0.08, partial: false },
    { name: 'grbw-rgbw', wire: 'GRBW', text: 'RGBW', white: true, reset: true, skew: 0, partial: false },
    { name: 'wbrg-bgrw', wire: 'WBRG', text: 'BGRW', white: true, reset: false, skew: 0.05, partial: true },
  ];
  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: 16_000_000,
      startSample: item.name === 'wbrg-bgrw' ? 9_007_199_254_740_990n : 31n,
      channels: { din: 4 },
      options: { wireorder: item.wire, textorder: item.text },
      chunkSamples: [1, 19, 257, 4093],
      minimumPayloadBits: 0,
      timingSkew: item.skew,
      *generate() {
        const data: WS2812Item[] = [],
          frames: ExpectedFrame[] = [];
        for (let index = 0; index < 12; index++) {
          const pixel: WS2812Pixel = {
            kind: 'pixel',
            r: (index * 37) & 0xff,
            g: (index * 73 + 11) & 0xff,
            b: (index * 109 + 23) & 0xff,
            ...(item.white ? { w: (index * 149 + 41) & 0xff } : {}),
          };
          data.push(pixel);
          frames.push(expected(pixel, index, item.text));
          if (item.reset && index === 5) data.push({ kind: 'reset' });
        }
        if (item.partial) data.push({ kind: 'partial', bits: [1, 0, 1, 1, 0, 0, 1] });
        yield {
          data,
          expected: frames,
          payloadBits: 12 * (item.white ? 32 : 24),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const pixelCount = Math.ceil(required / 32);
  const perBlock = 256;
  yield {
    name: 'seeded-long-rgbw',
    kind: 'long',
    seed,
    sampleRate: 8_000_000,
    startSample: 0n,
    channels: { din: 2 },
    options: { wireorder: 'GRBW', textorder: 'RGBW' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    timingSkew: 0,
    *generate() {
      const random = randomWords(seed);
      for (let offset = 0; offset < pixelCount; offset += perBlock) {
        const data: WS2812Item[] = [],
          expectedFrames: ExpectedFrame[] = [];
        for (let index = offset; index < Math.min(pixelCount, offset + perBlock); index++) {
          const pixel: WS2812Pixel = {
            kind: 'pixel',
            r: random() & 0xff,
            g: random() & 0xff,
            b: random() & 0xff,
            w: random() & 0xff,
          };
          data.push(pixel);
          expectedFrames.push(expected(pixel, index, 'RGBW'));
        }
        yield { data, expected: expectedFrames, payloadBits: data.length * 32 };
      }
    },
  };
}
