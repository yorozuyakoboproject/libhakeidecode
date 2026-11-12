import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';

export const VIS_UNIT = 8;
export const VIS_PREAMBLE = '1010101';
const IDLE = 6 * VIS_UNIT;

export interface VisWord {
  readonly bits: string;
}

export interface VisCase extends RoundtripCase<VisWord> {}

const OOK_OPTIONS = {
  invert: 'no',
  decodeas: 'NRZ',
  preamble: '1010',
  preamlen: '7',
  diffmanvar: '1',
};

function bitsWithPreamble(data: string): string {
  if (!data.length || /[^01]/.test(data)) throw new RangeError('OOK visualisation data must contain bits');
  if (data[0] === '1') data = '0' + data;
  if (data.at(-1) === '0') data += '1';
  return VIS_PREAMBLE + data;
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

function expectedPacket(start: bigint, word: VisWord): ExpectedFrame {
  const packetStart = start + BigInt(VIS_UNIT);
  const data: unknown[] = [];
  for (let index = 0; index < word.bits.length; index++) {
    const ss = packetStart + BigInt(index * VIS_UNIT);
    data.push([ss, ss + BigInt(VIS_UNIT), word.bits[index]!]);
  }
  const timeout = packetStart + BigInt(word.bits.length * VIS_UNIT);
  const timeoutEnd = timeout + BigInt(VIS_UNIT);
  data.push([timeout, timeoutEnd, word.bits.at(-1) === '1' ? '0' : '1']);
  return {
    ss: packetStart,
    es: timeoutEnd,
    protoId: 'ook',
    kind: 'protocol',
    data,
  };
}

function span(word: VisWord): number {
  return VIS_UNIT + word.bits.length * VIS_UNIT + IDLE;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4f4b5649,
}: GenerationOptions = {}): Iterable<VisCase> {
  const boundaryWord = { bits: bitsWithPreamble('0101101000111101') };
  yield {
    name: 'visible-nibbles',
    kind: 'boundary',
    seed,
    sampleRate: 1_000_000,
    startSample: 31n,
    channels: { data: 0 },
    options: { displayas: 'Nibble - Hex', synclen: '4', syncoffset: '0', refsample: 'off' },
    chain: [{ decoder: 'ook', options: OOK_OPTIONS }],
    chunkSamples: [2, 13, 257, 4093],
    minimumPayloadBits: 0,
    *generate() {
      yield {
        data: [boundaryWord],
        expected: [expectedPacket(31n, boundaryWord)],
        payloadBits: boundaryWord.bits.length - VIS_PREAMBLE.length,
      };
    },
  };

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const bitsPerWord = 100;
  const totalWords = Math.ceil(required / bitsPerWord);
  const wordsPerBlock = 256;
  const blocks = Math.ceil(totalWords / wordsPerBlock);
  yield {
    name: 'seeded-long-visible-nibbles',
    kind: 'long',
    seed,
    sampleRate: 1_000_000,
    startSample: 0n,
    channels: { data: 0 },
    options: { displayas: 'Nibble - Hex', synclen: '4', syncoffset: '0', refsample: 'off' },
    chain: [{ decoder: 'ook', options: OOK_OPTIONS }],
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      let wordIndex = 0;
      let nextSample = 0n;
      const random = randomWords(seed);
      for (let block = 0; block < blocks; block++) {
        const count = Math.min(wordsPerBlock, totalWords - wordIndex);
        const data: VisWord[] = [];
        const expected: ExpectedFrame[] = [];
        for (let index = 0; index < count; index++) {
          const payload = randomPayload(bitsPerWord, random);
          const word = { bits: bitsWithPreamble(payload) };
          data.push(word);
          expected.push(expectedPacket(nextSample, word));
          nextSample += BigInt(span(word));
          wordIndex++;
        }
        yield { data, expected, payloadBits: count * bitsPerWord };
      }
    },
  };
}
