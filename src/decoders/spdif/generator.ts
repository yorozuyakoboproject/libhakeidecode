import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export type SpdifPreamble = 'W' | 'M' | 'B';

export interface SpdifSubframe {
  readonly preamble: SpdifPreamble;
  readonly bits: readonly number[];
}

export interface SpdifCase extends RoundtripCase<SpdifSubframe> {}

export const SPDIF_UNIT_SAMPLES = 4;
export const SPDIF_PRELUDE_SAMPLES =
  2 * SPDIF_UNIT_SAMPLES +
  SPDIF_UNIT_SAMPLES +
  3 * SPDIF_UNIT_SAMPLES +
  2 * SPDIF_UNIT_SAMPLES +
  SPDIF_UNIT_SAMPLES +
  2 * SPDIF_UNIT_SAMPLES;
export const SPDIF_PREAMBLE_PULSES: Readonly<Record<SpdifPreamble, readonly number[]>> = {
  W: [2, 0, 1, 0],
  M: [2, 2, 1, 1],
  B: [2, 1, 1, 2],
};
export const SPDIF_SUBFRAME_SAMPLES = 256;

const CHANNELS = { data: 0 };
const SUMMARY: ExpectedFrame = { protoId: 'spdif', kind: 'summary' };

function syncAnnotations(start: bigint): ExpectedFrame[] {
  return [
    { ss: 0n, es: start + 12n, classIndex: 2, texts: ['Skip'] },
    {
      ss: start + 12n,
      es: start + 24n,
      classIndex: 2,
      texts: ['Found width 1: 12', 'W1: 12'],
    },
    {
      ss: start + 24n,
      es: start + 32n,
      classIndex: 2,
      texts: ['Found width 2: 8', 'W2: 8'],
    },
    {
      ss: start + 32n,
      es: start + 36n,
      classIndex: 2,
      texts: ['Found width 3: 4', 'W3: 4'],
    },
    { ss: 0n, es: start + 36n, classIndex: 0, texts: ['Synchronisation'] },
  ];
}

export function subframeStart(start: bigint, index: number): bigint {
  return start + BigInt(SPDIF_PRELUDE_SAMPLES + index * SPDIF_SUBFRAME_SAMPLES);
}

export function subframeAnnotations(subframe: SpdifSubframe, start: bigint): ExpectedFrame[] {
  const expected: ExpectedFrame[] = [];
  const preambleText = `Preamble ${subframe.preamble}`;
  expected.push({ ss: start, es: start + 32n, classIndex: 1, texts: [preambleText, subframe.preamble] });
  let cursor = start + 32n;
  for (const bit of subframe.bits) {
    expected.push({ ss: cursor, es: cursor + 8n, classIndex: 2, texts: [String(bit)] });
    cursor += 8n;
  }
  let value = 0;
  let reversed = 0;
  for (let index = 0; index < 24; index++) {
    const bit = subframe.bits[index]!;
    value = value * 2 + bit;
    reversed += bit * 2 ** index;
  }
  const hex = value.toString(16);
  const reversedHex = reversed.toString(16);
  const dataStart = start + 32n;
  expected.push({ ss: dataStart, es: dataStart + 32n, classIndex: 3, texts: [`Aux 0x${hex}`, `0x${hex}`] });
  expected.push({
    ss: dataStart + 32n,
    es: dataStart + 192n,
    classIndex: 3,
    texts: [`Sample 0x${hex}`, `0x${hex}`],
  });
  expected.push({
    ss: dataStart,
    es: dataStart + 192n,
    classIndex: 4,
    texts: [`Audio 0x${reversedHex}`, `0x${reversedHex}`],
  });
  expected.push({
    ss: dataStart + 192n,
    es: dataStart + 200n,
    classIndex: 5,
    texts: [subframe.bits[24] === 0 ? 'V' : 'E'],
  });
  expected.push({
    ss: dataStart + 200n,
    es: dataStart + 208n,
    classIndex: 6,
    texts: [`S: ${subframe.bits[25]}`],
  });
  expected.push({
    ss: dataStart + 208n,
    es: dataStart + 216n,
    classIndex: 7,
    texts: [`C: ${subframe.bits[26]}`],
  });
  expected.push({
    ss: dataStart + 216n,
    es: dataStart + 224n,
    classIndex: 8,
    texts: [`P: ${subframe.bits[27]}`],
  });
  return expected;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x5350444946,
}: GenerationOptions = {}): Iterable<SpdifCase> {
  yield {
    name: 'preamble-w-m-b',
    kind: 'boundary',
    seed,
    sampleRate: 2_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [1, 7, 127, 4093],
    minimumPayloadBits: 0,
    *generate() {
      const data: SpdifSubframe[] = [
        { preamble: 'W', bits: Array.from({ length: 28 }, (_, index) => index & 1) },
        { preamble: 'M', bits: Array.from({ length: 28 }, (_, index) => (index >> 1) & 1) },
        { preamble: 'B', bits: Array.from({ length: 28 }, (_, index) => (index >> 2) & 1) },
      ];
      const expectedAnnotations = syncAnnotations(0n);
      for (let index = 0; index < data.length; index++)
        expectedAnnotations.push(...subframeAnnotations(data[index]!, subframeStart(0n, index)));
      yield {
        data,
        expected: [SUMMARY],
        expectedAnnotations,
        annotationCount: expectedAnnotations.length,
        payloadBits: data.length * 28,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const total = Math.ceil(required / 28);
  const perBlock = 512;
  yield {
    name: 'seeded-long-subframes',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: CHANNELS,
    options: {},
    chunkSamples: [16381, 32749, 65521],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      const preambles: SpdifPreamble[] = ['W', 'M', 'B'];
      for (let offset = 0; offset < total; offset += perBlock) {
        const count = Math.min(perBlock, total - offset);
        const data: SpdifSubframe[] = Array.from({ length: count }, (_, index) => ({
          preamble: preambles[(offset + index) % preambles.length]!,
          bits: Array.from({ length: 28 }, () => random() & 1),
        }));
        const expectedAnnotations =
          offset === 0
            ? [...syncAnnotations(0n), ...subframeAnnotations(data[0]!, subframeStart(0n, 0))]
            : subframeAnnotations(data[0]!, subframeStart(0n, offset));
        const bitrate = offset === 0 ? 1 : 0;
        yield {
          data,
          expected: offset === 0 ? [SUMMARY] : [],
          expectedAnnotations,
          annotationCount: 5 * Number(offset === 0) + count * 36 + bitrate,
          payloadBits: count * 28,
        };
      }
    },
  };
}
