import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { segmentPattern } from './index.js';

export interface SevenSegmentState {
  readonly segments: number;
  readonly dp: boolean;
  readonly text: string;
}

export interface SevenSegmentCase extends RoundtripCase<SevenSegmentState> {}

export const SEVEN_SEGMENT_STATE_SAMPLES = 4;

const SEVEN_CHANNELS = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6 };
const WITH_DP = { ...SEVEN_CHANNELS, dp: 7 };
const SUMMARY: ExpectedFrame = { protoId: 'seven_segment', kind: 'summary' };

function state(character: string, dp = false): SevenSegmentState {
  const segments = segmentPattern(character);
  if (segments === undefined) throw new Error(`No segment pattern for ${character}`);
  return { segments, dp, text: character + (dp ? '.' : '') };
}

function annotations(data: readonly SevenSegmentState[], start: bigint): ExpectedFrame[] {
  return data.map((item, index) => ({
    ss: start + BigInt(index * SEVEN_SEGMENT_STATE_SAMPLES),
    es: start + BigInt((index + 1) * SEVEN_SEGMENT_STATE_SAMPLES),
    classIndex: 0,
    texts: [item.text],
  }));
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x37534547,
}: GenerationOptions = {}): Iterable<SevenSegmentCase> {
  yield {
    name: 'digits-common-cathode',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: SEVEN_CHANNELS,
    options: { polarity: 'common-cathode', show_unknown: 'no' },
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data = '0123456789'.split('').map((character) => state(character));
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: annotations(data, 0n),
        annotationCount: data.length,
        payloadBits: data.length * 8,
      };
    },
  };

  yield {
    name: 'decimal-point-common-anode',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: WITH_DP,
    options: { polarity: 'common-anode', show_unknown: 'no' },
    chunkSamples: [3, 31, 1021],
    minimumPayloadBits: 0,
    *generate() {
      const data = ['1', '2', '3'].map((character) => state(character, true));
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: annotations(data, 0n),
        annotationCount: data.length,
        payloadBits: data.length * 8,
      };
    },
  };

  yield {
    name: 'unknown-character',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: WITH_DP,
    options: { polarity: 'common-cathode', show_unknown: 'yes' },
    chunkSamples: [1, 5, 257],
    minimumPayloadBits: 0,
    *generate() {
      const data: SevenSegmentState[] = [{ segments: 0b0000011, dp: true, text: '#.' }];
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations: annotations(data, 0n),
        annotationCount: 1,
        payloadBits: 8,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const totalStates = Math.ceil(required / 8);
  const perBlock = 8192;
  const characters = '0123456789AbCdEF';
  yield {
    name: 'seeded-long-characters',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: SEVEN_CHANNELS,
    options: { polarity: 'common-cathode', show_unknown: 'no' },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let previous = -1;
      let cursor = 0n;
      for (let offset = 0; offset < totalStates; offset += perBlock) {
        const count = Math.min(perBlock, totalStates - offset);
        const data: SevenSegmentState[] = [];
        for (let index = 0; index < count; index++) {
          let selected = random() % characters.length;
          if (selected === previous) selected = (selected + 1) % characters.length;
          previous = selected;
          data.push(state(characters[selected]!));
        }
        const expectedAnnotations = annotations(data.slice(0, 1), cursor);
        cursor += BigInt(count * SEVEN_SEGMENT_STATE_SAMPLES);
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: count,
          payloadBits: count * 8,
        };
      }
    },
  };
}
