import { Decoder } from '../../libhakeidecode/index.js';
import { OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface SevenSegmentOptions {
  polarity: 'common-cathode' | 'common-anode';
  show_unknown: 'yes' | 'no';
}

export const SEGMENT_DIGITS = new Map<string, string>([
  ['0000000', ' '],
  ['0100010', '"'],
  ['1101111', '&'],
  ['0000010', "'"],
  ['0100000', "'"],
  ['0011000', ','],
  ['0000001', '-'],
  ['0000100', '.'],
  ['1111110', '0'],
  ['0110000', '1'],
  ['1101101', '2'],
  ['1111001', '3'],
  ['0110011', '4'],
  ['1011011', '5'],
  ['1011111', '6'],
  ['1110010', '7'],
  ['1110000', '7'],
  ['1111111', '8'],
  ['1111011', '9'],
  ['1000001', '='],
  ['0001001', '='],
  ['1100101', '?'],
  ['1110111', 'A'],
  ['1111101', 'a'],
  ['0011111', 'b'],
  ['1001110', 'C'],
  ['0001101', 'c'],
  ['0111101', 'd'],
  ['1001111', 'E'],
  ['1000111', 'F'],
  ['1011110', 'G'],
  ['0110111', 'H'],
  ['0010111', 'h'],
  ['0000110', 'I'],
  ['1000100', 'i'],
  ['0010000', 'i'],
  ['0111100', 'J'],
  ['0111000', 'J'],
  ['1011000', 'j'],
  ['1010111', 'K'],
  ['0001110', 'L'],
  ['1010100', 'M'],
  ['1010101', 'M'],
  ['1110110', 'N'],
  ['0010101', 'n'],
  ['0011101', 'o'],
  ['1100111', 'p'],
  ['1110011', 'q'],
  ['1100110', 'R'],
  ['0000101', 'r'],
  ['0001111', 't'],
  ['0011100', 'u'],
  ['0101010', 'V'],
  ['0100111', 'V'],
  ['0111110', 'V'],
  ['0100011', 'v'],
  ['0101011', 'W'],
  ['0010100', 'x'],
  ['0111011', 'y'],
  ['1101100', 'Z'],
  ['1100010', '^'],
  ['0001000', '_'],
]);

export function segmentPattern(character: string): number | undefined {
  for (const [pattern, value] of SEGMENT_DIGITS) {
    if (value !== character) continue;
    let bits = 0;
    for (let index = 0; index < 7; index++) if (pattern[index] === '1') bits |= 1 << index;
    return bits;
  }
  return undefined;
}

export class SevenSegmentDecoder extends Decoder<SevenSegmentOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private haveDp = false;
  private segCount = 7;
  private commonAnode = false;
  private showUnknown = false;

  override reset(): void {
    this.haveDp = false;
    this.segCount = 7;
    this.commonAnode = false;
    this.showUnknown = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.haveDp = this.hasChannel('dp');
    this.segCount = this.haveDp ? 8 : 7;
    this.commonAnode = this.options.polarity === 'common-anode';
    this.showUnknown = this.options.show_unknown === 'yes';
  }

  *decode(): LogicGenerator {
    let previous = Array.from(yield this.wait());
    if (previous.slice(0, 7).some((pin) => pin !== 0 && pin !== 1)) throw new Error('Need at least segments A-G.');
    let lastPosition = this.samplenum;
    const conditions: Record<string, 'e'>[] = [
      { a: 'e' },
      { b: 'e' },
      { c: 'e' },
      { d: 'e' },
      { e: 'e' },
      { f: 'e' },
      { g: 'e' },
      ...(this.haveDp ? [{ dp: 'e' as const }] : []),
    ];

    while (true) {
      const pins = Array.from(yield this.wait(conditions));
      const active = previous.slice(0, this.segCount).map((pin) => (this.commonAnode ? 1 - Number(pin) : Number(pin)));
      let digit = SEGMENT_DIGITS.get(active.slice(0, 7).join(''));
      if (digit === undefined && this.showUnknown) digit = '#';
      if (digit !== undefined) {
        if (this.haveDp && active[7] === 1) digit += '.';
        this.put(lastPosition, this.samplenum, this.outAnn, [0, [digit]]);
      }
      previous = pins;
      lastPosition = this.samplenum;
    }
  }
}

export default SevenSegmentDecoder;
