import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export const OOK_UNIT_SAMPLES = 8;
export const OOK_LEAD_SAMPLES = OOK_UNIT_SAMPLES;
export const OOK_IDLE_SAMPLES = 6 * OOK_UNIT_SAMPLES;
export const OOK_PREAMBLE = '1010101';

export interface OokWord {
  readonly bits: string;
  readonly bitSamples?: number;
}

export interface OokCase extends RoundtripCase<OokWord> {}

interface CaseConfig {
  readonly name: string;
  readonly kind: 'boundary' | 'long';
  readonly seed: number;
  readonly sampleRate: number;
  readonly startSample: bigint;
  readonly channels: Readonly<Record<string, number>>;
  readonly options: Record<string, OptionValue>;
  readonly chunkSamples: readonly number[];
  readonly minimumPayloadBits: number;
}

function wordBits(data: string): string {
  if (!data.length || /[^01]/.test(data)) throw new RangeError('OOK data must contain bits');
  if (data[0] === '1') data = '0' + data;
  if (data.at(-1) === '0') data += '1';
  return OOK_PREAMBLE + data;
}

function randomPayload(length: number, random: () => number): string {
  const bits = ['0'];
  let value = '0';
  let run = 1;
  while (bits.length < length - 1) {
    let next = String(random() & 1);
    if (next === value && run === 4) next = next === '0' ? '1' : '0';
    run = next === value ? run + 1 : 1;
    value = next;
    bits.push(next);
  }
  if (value === '1' && run === 4) bits[bits.length - 1] = '0';
  bits.push('1');
  return bits.join('');
}

function bitWidth(word: OokWord): number {
  return word.bitSamples ?? OOK_UNIT_SAMPLES;
}

function wordSpan(word: OokWord): number {
  const width = bitWidth(word);
  return width + word.bits.length * width + OOK_IDLE_SAMPLES * (width / OOK_UNIT_SAMPLES);
}

function expectedWord(startSample: bigint, word: OokWord): ExpectedFrame {
  const width = bitWidth(word);
  const packetStart = startSample + BigInt(width);
  const data: unknown[] = [];
  const bits = word.bits;
  for (let index = 0; index < bits.length; index++) {
    const ss = packetStart + BigInt(index * width);
    data.push([ss, ss + BigInt(width), bits[index]!]);
  }
  const timeoutStart = packetStart + BigInt(bits.length * width);
  const timeoutEnd = timeoutStart + BigInt(width);
  data.push([timeoutStart, timeoutEnd, bits.at(-1) === '1' ? '0' : '1']);
  return {
    ss: packetStart,
    es: timeoutEnd,
    protoId: 'ook',
    kind: 'protocol',
    data,
  };
}

function makeCase(config: CaseConfig, words: readonly OokWord[]): OokCase {
  return {
    ...config,
    *generate() {
      let start = config.startSample;
      const expected: ExpectedFrame[] = [];
      for (const word of words) {
        expected.push(expectedWord(start, word));
        start += BigInt(wordSpan(word));
      }
      yield {
        data: words,
        expected,
        payloadBits: words.reduce((total, word) => total + word.bits.length - OOK_PREAMBLE.length, 0),
      };
    },
  };
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4f4f4b31,
}: GenerationOptions = {}): Iterable<OokCase> {
  const base = {
    seed,
    sampleRate: 1_000_000,
    channels: { data: 0 },
    options: { invert: 'no', decodeas: 'NRZ', preamble: '1010', preamlen: '7', diffmanvar: '1' },
  };

  yield makeCase(
    {
      ...base,
      name: 'nrz-min-max-runs',
      kind: 'boundary',
      startSample: 23n,
      chunkSamples: [1, 7, 127, 4093],
      minimumPayloadBits: 0,
    },
    [
      { bits: wordBits('01') },
      { bits: wordBits('0' + '11110'.repeat(7) + '1') },
      { bits: wordBits('0011110000111100001111000011110001') },
    ],
  );

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerWord = 32;
  const totalWords = Math.ceil(required / bitsPerWord);
  const wordsPerBlock = 1024;
  const blocks = Math.ceil(totalWords / wordsPerBlock);
  yield {
    ...base,
    name: 'seeded-long-nrz',
    kind: 'long',
    startSample: 0n,
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let wordIndex = 0;
      let nextSample = 0n;
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(wordsPerBlock, totalWords - wordIndex);
        const data: OokWord[] = [];
        const expected: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const payload = randomPayload(bitsPerWord, random);
          const word = { bits: wordBits(payload) };
          data.push(word);
          expected.push(expectedWord(nextSample, word));
          nextSample += BigInt(wordSpan(word));
          wordIndex++;
        }
        yield { data, expected, payloadBits: count * bitsPerWord };
      }
    },
  };
}
