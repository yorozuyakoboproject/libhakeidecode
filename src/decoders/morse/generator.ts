import { MIN_PAYLOAD_BITS, randomWords } from '../../build/roundtrip.js';
import type { ExpectedFrame, GenerationOptions, RoundtripCase } from '../../build/roundtrip.js';
import { formatGeneral, morseText, morseUnits, roundHalfEven } from './index.js';

export interface MorseSymbol {
  readonly code: string;
  readonly gap: 'letter' | 'word';
}

export interface MorseCase extends RoundtripCase<MorseSymbol> {}

const VALID_SYMBOLS = new Set(['1,1', '1,3', '0,1', '0,3', '0,7']);
const LONG_CODES = [
  '.-',
  '-...',
  '-.-.',
  '-..',
  '.',
  '..-.',
  '--.',
  '....',
  '..',
  '.---',
  '-.-',
  '.-..',
  '--',
  '-.',
  '---',
];

function gapUnits(symbol: MorseSymbol): number {
  return symbol.gap === 'word' ? 7 : 3;
}

function symbolDuration(symbol: MorseSymbol, unitSamples: number): number {
  const units = morseUnits(symbol.code);
  return (units.reduce((sum, value) => sum + value, 0) + units.length - 1 + gapUnits(symbol)) * unitSamples;
}

function letterInterval(symbol: MorseSymbol, firstMark: bigint, unitSamples: number): { start: bigint; end: bigint } {
  const units = morseUnits(symbol.code);
  let duration = units.reduce((sum, value) => sum + value, 0) + units.length - 1;
  duration *= unitSamples;
  return { start: firstMark, end: firstMark + BigInt(duration) };
}

export function expectedMorse(
  symbols: readonly MorseSymbol[],
  sampleRate: number,
  options: Record<string, string | number | boolean>,
  firstMark: bigint,
  unitSamples: number,
): { annotations: ExpectedFrame[]; count: number; end: bigint } {
  let timeunit = Number(options.timeunit);
  const timeout = Math.max(1, Math.trunc(5 * sampleRate * timeunit));
  const annotations: ExpectedFrame[] = [];
  const segments: { level: 0 | 1; start: bigint; end: bigint }[] = [];
  let cursor = firstMark;

  for (const symbol of symbols) {
    const units = morseUnits(symbol.code);
    for (let index = 0; index < units.length; index++) {
      const duration = units[index]! * unitSamples;
      segments.push({ level: 1, start: cursor, end: cursor + BigInt(duration) });
      cursor += BigInt(duration);
      if (index + 1 < units.length) {
        segments.push({ level: 0, start: cursor, end: cursor + BigInt(unitSamples) });
        cursor += BigInt(unitSamples);
      }
    }
    const duration = gapUnits(symbol) * unitSamples;
    segments.push({ level: 0, start: cursor, end: cursor + BigInt(duration) });
    cursor += BigInt(duration);
  }

  let sequence: number[] = [];
  let letterStart: bigint | null = null;
  let letterEnd: bigint | null = null;
  let word = '';
  let wordStart: bigint | null = null;
  let wordEnd: bigint | null = null;

  const flushLetter = (): void => {
    if (!sequence.length || letterStart === null || letterEnd === null) return;
    const code = sequence.map((units) => (units === 3 ? '-' : '.')).join('');
    const letter = morseText(code);
    annotations.push({ classIndex: 3, texts: [letter], ss: letterStart, es: letterEnd });
    if (!word) wordStart = letterStart;
    word += letter;
    wordEnd = letterEnd;
    sequence = [];
    letterStart = null;
    letterEnd = null;
  };

  const flushWord = (): void => {
    if (!word || wordStart === null || wordEnd === null) return;
    annotations.push({ classIndex: 4, texts: [word], ss: wordStart, es: wordEnd });
    word = '';
    wordStart = null;
    wordEnd = null;
  };

  let previousTime = firstMark;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment.level === 0 && Number(segment.end - segment.start) >= timeout) {
      flushLetter();
      flushWord();
    }
    if (index + 1 === segments.length) break;
    const dt = Number(segment.end - previousTime) / sampleRate;
    const units = dt / timeunit;
    const integerUnits = Math.trunc(Math.max(1, roundHalfEven(units)));
    const error = Math.abs(units - integerUnits);
    annotations.push({
      classIndex: 0,
      texts: [formatGeneral(dt)],
      ss: previousTime,
      es: segment.end,
    });
    const symbol = `${segment.level},${integerUnits}`;
    if (VALID_SYMBOLS.has(symbol)) {
      annotations.push({
        classIndex: 1,
        texts: [`${units.toFixed(1)}*${formatGeneral(timeunit)}`],
        ss: previousTime,
        es: segment.end,
      });
      if (segment.level === 1) {
        if (letterStart === null) letterStart = previousTime;
        letterEnd = segment.end;
        sequence.push(integerUnits);
      } else if (integerUnits >= 3) {
        flushLetter();
      }
    } else {
      annotations.push({
        classIndex: 1,
        texts: [`!! ${units.toFixed(1)}*${formatGeneral(timeunit)} !!`],
        ss: previousTime,
        es: segment.end,
      });
    }
    previousTime = segment.end;
    const thisUnit = dt / integerUnits;
    timeunit += (thisUnit - timeunit) * 0.2 * Math.max(0, 1 - 2 * error);
  }

  return { annotations, count: annotations.length, end: cursor };
}

function blockCount(symbols: readonly MorseSymbol[], first: boolean): number {
  let marks = 0;
  let words = 0;
  for (const symbol of symbols) {
    marks += morseUnits(symbol.code).length;
    if (symbol.gap === 'word') words++;
  }
  const pairs = 2 * marks - 1 + (first ? 0 : 1);
  return 2 * pairs + symbols.length + words;
}

export function* cases({
  minimumPayloadBits = MIN_PAYLOAD_BITS,
  seed = 0x4d4f5253,
}: GenerationOptions = {}): Iterable<MorseCase> {
  const boundaries: readonly {
    name: string;
    symbols: readonly MorseSymbol[];
    sampleRate: number;
    timeunit: number;
    startSample: bigint;
  }[] = [
    {
      name: 'sos-default',
      symbols: [
        { code: '...', gap: 'letter' },
        { code: '---', gap: 'letter' },
        { code: '...', gap: 'word' },
      ],
      sampleRate: 1_000,
      timeunit: 0.1,
      startSample: 7n,
    },
    {
      name: 'punctuation-and-unknown',
      symbols: [
        { code: '..--..', gap: 'letter' },
        { code: '.----.', gap: 'letter' },
        { code: '.-.-.-', gap: 'letter' },
        { code: '....--', gap: 'word' },
      ],
      sampleRate: 2_000,
      timeunit: 0.001,
      startSample: 9_007_199_254_740_990n,
    },
    {
      name: 'minimum-elements',
      symbols: [
        { code: '.', gap: 'letter' },
        { code: '-', gap: 'word' },
      ],
      sampleRate: 1_000,
      timeunit: 0.002,
      startSample: 0n,
    },
  ];

  for (const item of boundaries) {
    const unitSamples = Math.round(item.sampleRate * item.timeunit);
    const firstMark = item.startSample + 1n;
    const expected = expectedMorse(item.symbols, item.sampleRate, { timeunit: item.timeunit }, firstMark, unitSamples);
    yield {
      name: item.name,
      kind: 'boundary',
      seed,
      sampleRate: item.sampleRate,
      startSample: item.startSample,
      channels: { data: 5 },
      options: { timeunit: item.timeunit },
      chunkSamples: [1, 3, 257, 4093],
      minimumPayloadBits: 0,
      *generate() {
        yield {
          data: item.symbols,
          expected: [{ protoId: 'morse', kind: 'summary' }],
          expectedAnnotations: expected.annotations,
          annotationCount: expected.count,
          payloadBits: item.symbols.reduce((sum, symbol) => sum + symbol.code.length, 0),
        };
      },
    };
  }

  const required = Math.max(MIN_PAYLOAD_BITS, minimumPayloadBits);
  const symbolCount = Math.ceil(required / 8);
  const perBlock = 1_024;
  const sampleRate = 5_000;
  const timeunit = 0.001;
  const unitSamples = Math.round(sampleRate * timeunit);
  yield {
    name: 'seeded-long-letters',
    kind: 'long',
    seed,
    sampleRate,
    startSample: 0n,
    channels: { data: 1 },
    options: { timeunit },
    chunkSamples: [4093, 8191, 16381],
    minimumPayloadBits: required,
    *generate() {
      const random = randomWords(seed);
      let cursor = 1n;
      for (let offset = 0; offset < symbolCount; offset += perBlock) {
        const data: MorseSymbol[] = [];
        const count = Math.min(perBlock, symbolCount - offset);
        for (let index = 0; index < count; index++) {
          data.push({
            code: LONG_CODES[random() % LONG_CODES.length]!,
            gap: (random() & 7) === 0 ? 'word' : 'letter',
          });
        }
        data[data.length - 1] = { ...data[data.length - 1]!, gap: 'word' };
        const first = letterInterval(data[0]!, cursor, unitSamples);
        const annotationCount = blockCount(data, offset === 0);
        for (const symbol of data) cursor += BigInt(symbolDuration(symbol, unitSamples));
        yield {
          data,
          expected: offset === 0 ? [{ protoId: 'morse', kind: 'summary' }] : [],
          expectedAnnotations: [
            {
              classIndex: 3,
              texts: [morseText(data[0]!.code)],
              ss: first.start,
              es: first.end,
            },
          ],
          annotationCount,
          payloadBits: data.length * 8,
        };
      }
    },
  };
}
