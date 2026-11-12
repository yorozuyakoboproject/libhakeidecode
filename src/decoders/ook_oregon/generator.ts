import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

const UNIT = 8;
const IDLE = 6 * UNIT;
const OOK_OPTIONS = {
  invert: 'no',
  decodeas: 'NRZ',
  preamble: '1010',
  preamlen: '3',
  diffmanvar: '1',
};

export interface OregonWord {
  readonly bits: string;
}

export interface OregonCase extends RoundtripCase<OregonWord> {}

function postSyncBits(random: (() => number) | null): string {
  let rolling = '';
  for (let index = 0; index < 8; index++) rolling += random ? String(random() & 1) : '0';
  return '0'.repeat(16) + '0000' + rolling + '0001' + '11101';
}

function oregonWord(random: (() => number) | null = null): OregonWord {
  const prefix = '101' + '0'.repeat(10) + '0101';
  return { bits: prefix + postSyncBits(random) };
}

function span(word: OregonWord): number {
  return UNIT + word.bits.length * UNIT + IDLE;
}

const SUMMARY: ExpectedFrame = { protoId: 'ook_oregon', kind: 'summary' };
const SENSOR: ExpectedFrame = { classIndex: 1, texts: ['SensorID: 0000', '0000'] };
const EXTRA: ExpectedFrame = { classIndex: 1, texts: ['7', '7'] };
const UNKNOWN: ExpectedFrame = { classIndex: 2, texts: ['Unknown - Unknown', 'Unknown', 'Unknown'] };
const CHANNEL: ExpectedFrame = { classIndex: 2, texts: ['Ch 0', '0'] };
const BATTERY: ExpectedFrame = { classIndex: 2, texts: ['Batt OK', 'OK'] };

function boundaryAnnotations(): ExpectedFrame[] {
  return [
    { classIndex: 1, texts: ['Oregon v3 Preamble', 'v3 Preamble', 'v3 Pre', 'v3'] },
    { classIndex: 1, texts: ['Sync', 'Syn', 'S'] },
    SENSOR,
    { classIndex: 1, texts: ['Ch: 0', '0'] },
    { classIndex: 1, texts: ['RollingCode: 00', '00'] },
    { classIndex: 1, texts: ['Flags1: 8', '8'] },
    EXTRA,
    UNKNOWN,
    CHANNEL,
    BATTERY,
  ];
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4f524547,
}: GenerationOptions = {}): Iterable<OregonCase> {
  const word = oregonWord();
  yield {
    name: 'v3-unknown-sensor',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 17n,
    channels: { data: 0 },
    options: { unknown: 'Unknown' },
    chain: [{ decoder: 'ook', options: OOK_OPTIONS }],
    chunkSamples: [1, 11, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [word],
        expected: [SUMMARY],
        expectedAnnotations: boundaryAnnotations(),
        annotationCount: 10,
        payloadBits: word.bits.length,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerWord = word.bits.length;
  const totalWords = Math.ceil(required / bitsPerWord);
  const wordsPerBlock = 512;
  const blocks = Math.ceil(totalWords / wordsPerBlock);
  yield {
    name: 'seeded-long-v3',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { data: 0 },
    options: { unknown: 'Unknown' },
    chain: [{ decoder: 'ook', options: OOK_OPTIONS }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let wordIndex = 0;
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(wordsPerBlock, totalWords - wordIndex);
        const data: OregonWord[] = [];
        for (let index = 0; index < count; index++) data.push(oregonWord(random));
        yield {
          data,
          expected: block === 0 ? [SUMMARY] : [],
          expectedAnnotations: [SENSOR, EXTRA, UNKNOWN, CHANNEL, BATTERY],
          annotationCount: data.length * 10,
          payloadBits: count * bitsPerWord,
        };
        wordIndex += count;
      }
    },
  };
}

export { span as oregonWordSpan };
