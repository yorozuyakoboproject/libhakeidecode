import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { sircFrameBits, type SircFrame } from './index.js';
import { sircRemoteText } from './tables.js';

export interface SircCase extends RoundtripCase<SircFrame> {}

export const SIRC_SAMPLE_RATE = 4000;
export const SIRC_LEAD_SAMPLES = 10;
export const SIRC_GAP_SAMPLES = 10;

export interface SircTiming {
  readonly agc: number;
  readonly pause: number;
  readonly one: number;
  readonly zero: number;
}

export function sircTiming(sampleRate: number): SircTiming {
  return {
    agc: Math.round((2400 * sampleRate) / 1e6),
    pause: Math.max(1, Math.round((500 * sampleRate) / 1e6)),
    one: Math.round((1250 * sampleRate) / 1e6),
    zero: Math.max(1, Math.round((500 * sampleRate) / 1e6)),
  };
}

export function sircFrameSamples(frame: SircFrame, timing: SircTiming): number {
  return (
    timing.agc +
    timing.pause +
    sircFrameBits(frame).reduce((sum, bit) => sum + (bit ? timing.one : timing.zero) + timing.pause, 0) +
    SIRC_GAP_SAMPLES
  );
}

export function sircFrameAnnotations(frame: SircFrame, frameStart: bigint, timing: SircTiming): ExpectedFrame[] {
  const bits = sircFrameBits(frame);
  const agcEnd = frameStart + BigInt(timing.agc);
  const pauseEnd = agcEnd + BigInt(timing.pause);
  let cursor = pauseEnd;
  const bitRanges: { ss: bigint; es: bigint; bit: number }[] = [];
  for (const bit of bits) {
    const ss = cursor;
    cursor += BigInt((bit ? timing.one : timing.zero) + timing.pause);
    bitRanges.push({ ss, es: cursor, bit });
  }
  const addressBits = frame.extended == null ? (frame.addressBits ?? 5) : 5;
  const command = bitRanges.slice(0, 7);
  const address = bitRanges.slice(7, 7 + addressBits);
  const extended = frame.extended == null ? [] : bitRanges.slice(7 + addressBits, 20);
  const extendedValue = frame.extended ?? null;
  const result: ExpectedFrame[] = [
    { classIndex: 1, texts: ['AGC', 'A'], ss: frameStart, es: agcEnd },
    { classIndex: 2, texts: ['Pause', 'P'], ss: agcEnd, es: pauseEnd },
    { classIndex: 3, texts: ['Start', 'S'], ss: frameStart, es: pauseEnd },
  ];
  for (const bit of bitRanges) {
    result.push({ classIndex: 0, texts: [String(bit.bit)], ss: bit.ss, es: bit.es });
  }
  result.push({
    classIndex: 4,
    texts: [
      `Command: 0x${frame.command.toString(16).toUpperCase().padStart(2, '0')}`,
      `C:0x${frame.command.toString(16).toUpperCase().padStart(2, '0')}`,
    ],
    ss: command[0]!.ss,
    es: command.at(-1)!.es,
  });
  result.push({
    classIndex: 5,
    texts: [
      `Address: 0x${frame.address.toString(16).toUpperCase().padStart(2, '0')}`,
      `A:0x${frame.address.toString(16).toUpperCase().padStart(2, '0')}`,
    ],
    ss: address[0]!.ss,
    es: address.at(-1)!.es,
  });
  if (extendedValue !== null) {
    result.push({
      classIndex: 6,
      texts: [
        `Extended: 0x${extendedValue.toString(16).toUpperCase().padStart(2, '0')}`,
        `E:0x${extendedValue.toString(16).toUpperCase().padStart(2, '0')}`,
      ],
      ss: extended[0]!.ss,
      es: extended.at(-1)!.es,
    });
  }
  result.push({
    classIndex: 7,
    texts: sircRemoteText(frame.address, frame.command, extendedValue),
    ss: frameStart,
    es: bitRanges.at(-1)!.es,
  });
  return result;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x53495243,
}: GenerationOptions = {}): Iterable<SircCase> {
  const timing = sircTiming(SIRC_SAMPLE_RATE);
  const boundaries = [
    {
      name: 'sirc12-tv-power',
      polarity: 'active-low' as const,
      startSample: 3n,
      frames: [
        { command: 0x15, address: 0x01, addressBits: 5 as const },
        { command: 0x25, address: 0x01, addressBits: 5 as const },
      ],
    },
    {
      name: 'sirc15-tv-extra',
      polarity: 'active-low' as const,
      startSample: 9_007_199_254_740_990n,
      frames: [
        { command: 0x23, address: 0x97, addressBits: 8 as const },
        { command: 0x36, address: 0x97, addressBits: 8 as const },
      ],
    },
    {
      name: 'sirc20-playback',
      polarity: 'active-low' as const,
      startSample: 19n,
      frames: [
        { command: 0x32, address: 0x10, extended: 0x08 },
        { command: 0x38, address: 0x10, extended: 0x08 },
      ],
    },
    {
      name: 'sirc20-active-high',
      polarity: 'active-high' as const,
      startSample: 31n,
      frames: [
        { command: 0x7f, address: 0x1f, extended: 0xa5 },
        { command: 0x00, address: 0x00, extended: 0x00 },
      ],
    },
  ];

  for (const item of boundaries) {
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: SIRC_SAMPLE_RATE,
      startSample: item.startSample,
      channels: { ir: 4 },
      options: { polarity: item.polarity },
      chunkSamples: [3, 17, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        let cursor = item.startSample + BigInt(SIRC_LEAD_SAMPLES);
        const expectedAnnotations: ExpectedFrame[] = [];
        for (const frame of item.frames) {
          expectedAnnotations.push(...sircFrameAnnotations(frame, cursor, timing));
          cursor += BigInt(sircFrameSamples(frame, timing));
        }
        yield {
          data: item.frames,
          expected: [{ protoId: 'ir_sirc', kind: 'summary' }],
          expectedAnnotations,
          annotationCount: expectedAnnotations.length,
          payloadBits: item.frames.reduce((sum, frame) => sum + sircFrameBits(frame).length, 0),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const payloadPerFrame = 20;
  const frameCount = Math.ceil(required / payloadPerFrame);
  const perBlock = 2048;
  yield {
    name: 'seeded-long-sirc20',
    kind: 'long',
    seed,
    sampleRate: SIRC_SAMPLE_RATE,
    startSample: 0n,
    channels: { ir: 0 },
    options: { polarity: 'active-low' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = BigInt(SIRC_LEAD_SAMPLES);
      for (let offset = 0; offset < frameCount; offset += perBlock) {
        const count = Math.min(perBlock, frameCount - offset);
        const data: SircFrame[] = [];
        let firstLayout: ExpectedFrame[] | null = null;
        let lastLayout: ExpectedFrame[] | null = null;
        for (let index = 0; index < count; index++) {
          const word = random();
          const frame: SircFrame = {
            command: word & 0x7f,
            address: (word >>> 7) & 0x1f,
            extended: (word >>> 12) & 0xff,
          };
          data.push(frame);
          const layout = sircFrameAnnotations(frame, cursor, timing);
          firstLayout ??= layout;
          lastLayout = layout;
          cursor += BigInt(sircFrameSamples(frame, timing));
        }
        const firstFields = firstLayout!.slice(-4);
        const lastFields = lastLayout!.slice(-4);
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'ir_sirc', kind: 'summary' }] : [],
          expectedAnnotations: [...firstFields, ...lastFields],
          annotationCount: count * 27,
          payloadBits: count * payloadPerFrame,
        };
      }
    },
  };
}
