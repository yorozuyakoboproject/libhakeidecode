import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface MorseOptions {
  timeunit: number;
}

const MORSE_TEXT: Readonly<Record<string, string>> = {
  '.-': 'a',
  '-...': 'b',
  '-.-.': 'c',
  '-..': 'd',
  '.': 'e',
  '..-..': 'é',
  '..-.': 'f',
  '--.': 'g',
  '....': 'h',
  '..': 'i',
  '.---': 'j',
  '-.-': 'k',
  '.-..': 'l',
  '--': 'm',
  '-.': 'n',
  '---': 'o',
  '.--.': 'p',
  '--.-': 'q',
  '.-.': 'r',
  '...': 's',
  '-': 't',
  '..-': 'u',
  '...-': 'v',
  '.--': 'w',
  '-..-': 'x',
  '-.--': 'y',
  '--..': 'z',
  '.----': '1',
  '..---': '2',
  '...--': '3',
  '....-': '4',
  '.....': '5',
  '-....': '6',
  '--...': '7',
  '---..': '8',
  '----.': '9',
  '-----': '0',
  '.-.-.-': '.',
  '--..--': ',',
  '---...': ':',
  '..--..': '?',
  '.----.': '’',
  '-....-': '-',
  '-..-.': '/',
  '-.--.': '(',
  '-.--.-': ')',
  '.-..-.': '“ ”',
  '-...-': '=',
  '...-.': 'UNDERSTOOD',
  '........': 'ERROR',
  '.-.-.': '+',
  '.-...': 'WAIT',
  '...-.-': 'EOW',
  '-.-.-': 'START',
  '.--.-.': '@',
};

const VALID_SYMBOLS = new Set(['1,1', '1,3', '0,1', '0,3', '0,7']);

export function morseText(code: string): string {
  return MORSE_TEXT[code] ?? code;
}

export function morseUnits(code: string): number[] {
  const units: number[] = [];
  for (const char of code) {
    if (char === '.') units.push(1);
    else if (char === '-') units.push(3);
    else throw new RangeError('Morse code contains an invalid element.');
  }
  return units;
}

export function roundHalfEven(value: number): number {
  const lower = Math.floor(value);
  const difference = value - lower;
  if (difference < 0.5) return lower;
  if (difference > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

export function formatGeneral(value: number, precision = 3): string {
  if (value === 0) return '0';
  if (!Number.isFinite(value)) return String(value);
  const [rawMantissa, rawExponent] = value.toExponential(precision - 1).split('e');
  const exponent = Number(rawExponent);
  if (exponent < -4 || exponent >= precision) {
    const mantissa = rawMantissa!.includes('.') ? rawMantissa!.replace(/0+$/, '').replace(/\.$/, '') : rawMantissa!;
    const magnitude = String(Math.abs(exponent)).padStart(2, '0');
    return `${mantissa}e${exponent < 0 ? '-' : '+'}${magnitude}`;
  }
  const decimals = Math.max(0, precision - 1 - exponent);
  const fixed = value.toFixed(decimals);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

export class MorseDecoder extends Decoder<MorseOptions> {
  static descriptor = descriptor;

  samplerate: number | null = null;
  private outAnn = -1;

  constructor(options: Partial<MorseOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) this.samplerate = 1;
    let timeunit = Number(this.options.timeunit);
    if (!(timeunit > 0) || !Number.isFinite(timeunit)) throw new RangeError('Morse time unit must be positive.');

    yield this.wait({ data: 'r' });
    let previousTime = this.samplenum;
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
      this.put(letterStart, letterEnd, this.outAnn, [3, [letter]]);
      if (!word) wordStart = letterStart;
      word += letter;
      wordEnd = letterEnd;
      sequence = [];
      letterStart = null;
      letterEnd = null;
    };

    const flushWord = (): void => {
      if (!word || wordStart === null || wordEnd === null) return;
      this.put(wordStart, wordEnd, this.outAnn, [4, [word]]);
      word = '';
      wordStart = null;
      wordEnd = null;
    };

    while (true) {
      const timeout = Math.max(1, Math.trunc(5 * this.samplerate * timeunit));
      const pins = yield this.wait([{ data: 'e' }, { skip: timeout }]);
      const now = this.samplenum;
      if (this.matched?.[1]) {
        flushLetter();
        flushWord();
        continue;
      }

      const previousLevel = 1 - Number(pins[0]);
      const dt = Number(now - previousTime) / this.samplerate;
      const units = dt / timeunit;
      const integerUnits = Math.trunc(Math.max(1, roundHalfEven(units)));
      const error = Math.abs(units - integerUnits);

      this.put(previousTime, now, this.outAnn, [0, [formatGeneral(dt)]]);
      const symbol = `${previousLevel},${integerUnits}`;
      if (VALID_SYMBOLS.has(symbol)) {
        this.put(previousTime, now, this.outAnn, [1, [`${units.toFixed(1)}*${formatGeneral(timeunit)}`]]);
        if (previousLevel === 1) {
          if (letterStart === null) letterStart = previousTime;
          letterEnd = now;
          sequence.push(integerUnits);
        } else if (integerUnits >= 3) {
          flushLetter();
        }
      } else {
        this.put(previousTime, now, this.outAnn, [1, [`!! ${units.toFixed(1)}*${formatGeneral(timeunit)} !!`]]);
      }

      previousTime = now;
      const thisUnit = dt / integerUnits;
      timeunit += (thisUnit - timeunit) * 0.2 * Math.max(0, 1 - 2 * error);
    }
  }
}

export default MorseDecoder;
