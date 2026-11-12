import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export interface TdmFrame {
  readonly samples: readonly number[];
}

export interface TdmCase extends RoundtripCase<TdmFrame> {}

export const TDM_SAMPLES_PER_BIT = 2;

const CHANNELS = { clock: 3, frame: 5, data: 7 };
const SUMMARY: ExpectedFrame = { protoId: 'tdm_audio', kind: 'summary' };

function hex(value: number, bits: number): string {
  return value.toString(16).padStart(bits <= 8 ? 2 : bits <= 16 ? 4 : 8, '0');
}

function expectedAnnotations(
  frames: readonly TdmFrame[],
  start: bigint,
  firstFrame: number,
  samplesPerChannel: number,
  channelCount: number,
  previous: { es: bigint | null },
): ExpectedFrame[] {
  const expected: ExpectedFrame[] = [];
  const frameSamples = BigInt(TDM_SAMPLES_PER_BIT * (1 + samplesPerChannel * channelCount));
  for (let frameOffset = 0; frameOffset < frames.length; frameOffset++) {
    const frameStart = start + BigInt(firstFrame + frameOffset) * frameSamples;
    if (samplesPerChannel === 1 && firstFrame + frameOffset > 0) {
      const es = frameStart + 1n;
      const channel = channelCount + 1;
      expected.push({
        ss: previous.es ?? 0n,
        es,
        classIndex: 0,
        texts: [`Channel ${channel}: 00`, `C${channel}: 00`, `${channel}: 00`],
      });
      previous.es = es;
    }
    for (let index = 0; index < channelCount; index++) {
      const es =
        frameStart +
        BigInt(TDM_SAMPLES_PER_BIT * samplesPerChannel + 1 + TDM_SAMPLES_PER_BIT * samplesPerChannel * index);
      const ss = previous.es ?? 0n;
      const channel = index + 1;
      const value = hex(frames[frameOffset]!.samples[index]!, samplesPerChannel);
      expected.push({
        ss,
        es,
        classIndex: channel < channelCount ? channel : 0,
        texts: [`Channel ${channel}: ${value}`, `C${channel}: ${value}`, `${channel}: ${value}`],
      });
      previous.es = es;
    }
  }
  return expected;
}

function payloadBits(frames: readonly TdmFrame[], samplesPerChannel: number): number {
  return frames.reduce((sum, frame) => sum + frame.samples.length * samplesPerChannel, 0);
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x54444d,
}: GenerationOptions = {}): Iterable<TdmCase> {
  yield {
    name: 'one-bit-mono',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 17n,
    channels: CHANNELS,
    options: { bps: 1, channels: 1, edge: 'rising' },
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: TdmFrame[] = [{ samples: [1] }, { samples: [0] }, { samples: [1] }];
      const previous = { es: null as bigint | null };
      const expected = expectedAnnotations(data, 17n, 0, 1, 1, previous);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: expected,
        annotationCount: expected.length,
        payloadBits: payloadBits(data, 1),
      };
    },
  };

  yield {
    name: 'four-channel-eight-bit-falling',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 9_007_199_254_740_900n,
    channels: CHANNELS,
    options: { bps: 8, channels: 4, edge: 'falling' },
    chunkSamples: [3, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data: TdmFrame[] = [{ samples: [0x00, 0x7f, 0x80, 0xff] }, { samples: [0x12, 0x34, 0x56, 0x78] }];
      const previous = { es: null as bigint | null };
      const expected = expectedAnnotations(data, 9_007_199_254_740_900n, 0, 8, 4, previous);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: expected,
        annotationCount: expected.length,
        payloadBits: payloadBits(data, 8),
      };
    },
  };

  yield {
    name: 'thirty-two-bit-eight-channel',
    kind: 'boundary',
    seed,
    sampleRate: 4_000_000,
    startSample: 5n,
    channels: CHANNELS,
    options: { bps: 32, channels: 8, edge: 'rising' },
    chunkSamples: [15, 255, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: TdmFrame[] = [
        { samples: [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xabcdef01, 0xffffffff] },
      ];
      const previous = { es: null as bigint | null };
      const expected = expectedAnnotations(data, 5n, 0, 32, 8, previous);
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: expected,
        annotationCount: expected.length,
        payloadBits: 256,
      };
    },
  };

  const bps = 16;
  const channelCount = 8;
  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalFrames = Math.ceil(required / (bps * channelCount));
  const perBlock = 1024;
  yield {
    name: 'seeded-long-eight-channel',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: { bps, channels: channelCount, edge: 'rising' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const previous = { es: null as bigint | null };
      for (let offset = 0; offset < totalFrames; offset += perBlock) {
        const count = Math.min(perBlock, totalFrames - offset);
        const data: TdmFrame[] = Array.from({ length: count }, () => ({
          samples: Array.from({ length: channelCount }, () => random() & 0xffff),
        }));
        const all = expectedAnnotations(data, 0n, offset, bps, channelCount, previous);
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations: all.slice(0, 1),
          annotationCount: count * channelCount,
          payloadBits: count * bps * channelCount,
        };
      }
    },
  };
}
