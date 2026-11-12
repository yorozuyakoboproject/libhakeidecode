import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

const MAX_DATA_LEN = 128;

export const ST7735_COMMANDS: Readonly<Record<number, readonly [name: string, description: string]>> = {
  0x00: ['NOP', 'No operation'],
  0x01: ['SWRESET', 'Software reset'],
  0x04: ['RDDID', 'Read display ID'],
  0x09: ['RDDST', 'Read display status'],
  0x10: ['SLPIN', 'Sleep in & booster off'],
  0x11: ['SLPOUT', 'Sleep out & booster on'],
  0x12: ['PTLON', 'Partial mode on'],
  0x13: ['NORON', 'Partial off (normal)'],
  0x20: ['INVOFF', 'Display inversion off'],
  0x21: ['INVON', 'Display inversion on'],
  0x28: ['DISPOFF', 'Display off'],
  0x29: ['DISPON', 'Display on'],
  0x2a: ['CASET', 'Column address set'],
  0x2b: ['RASET', 'Row address set'],
  0x2c: ['RAMWR', 'Memory write'],
  0x2e: ['RAMRD', 'Memory read'],
  0x30: ['PTLAR', 'Partial start/end address set'],
  0x36: ['MADCTL', 'Memory data address control'],
  0x3a: ['COLMOD', 'Interface pixel format'],
  0xb1: ['FRMCTR1', 'Frame rate control (in normal mode / full colors)'],
  0xb2: ['FRMCTR2', 'Frame rate control (in idle mode / 8-colors)'],
  0xb3: ['FRMCTR3', 'Frame rate control (in partial mode / full colors) '],
  0xb4: ['INVCTR', 'Display inversion control'],
  0xb6: ['DISSET5', 'Display function set 5'],
  0xc0: ['PWCTR1', 'Power control 1'],
  0xc1: ['PWCTR2', 'Power control 2'],
  0xc2: ['PWCTR3', 'Power control 3'],
  0xc3: ['PWCTR4', 'Power control 4'],
  0xc4: ['PWCTR5', 'Power control 5'],
  0xc5: ['VMCTR1', 'VCOM control 1'],
  0xda: ['RDID1', 'Read ID1'],
  0xdb: ['RDID2', 'Read ID2'],
  0xdc: ['RDID3', 'Read ID3'],
  0xdd: ['RDID4', 'Read ID4'],
  0xfc: ['PWCTR6', 'Power control 6'],
  0xe0: ['GMCTRP1', "Gamma '+'polarity correction characteristics setting"],
  0xe1: ['GMCTRN1', "Gamma '-'polarity correction characteristics setting"],
};

export function st7735Description(command: number, data: readonly number[]): string | null {
  if (command < 0) return null;
  const known = ST7735_COMMANDS[command];
  if (known) return `${known[0]}: ${known[1]}`;
  let values = data,
    dots = '';
  if (values.length === MAX_DATA_LEN) {
    values = values.slice(0, -1);
    dots = '...';
  }
  const contents =
    values.length > 0 ? values.map((value) => value.toString(16).toUpperCase().padStart(2, '0')).join(' ') : '(none)';
  return `Unknown command: ${command.toString(16).toUpperCase().padStart(2, '0')}. Data: ${contents}${dots}`;
}

export class St7735Decoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;
  private outAnn = -1;
  private accumByte = 0;
  private accumBits = 0;
  private bitStart: bigint | null = null;
  private byteStart: bigint | null = null;
  private currentBit: number | null = null;

  constructor(options: Record<string, never> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.accumByte = 0;
    this.accumBits = 0;
    this.bitStart = null;
    this.byteStart = null;
    this.currentBit = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putDescription(ss: bigint | null, es: bigint | null, command: number, data: readonly number[]): void {
    if (ss === null || es === null) return;
    const text = st7735Description(command, data);
    if (text !== null) this.put(ss, es, this.outAnn, [3, [text]]);
  }

  *decode(): LogicGenerator {
    let currentCommand = -1;
    let currentData: number[] = [];
    let descriptionStart: bigint | null = null;
    let descriptionEnd: bigint | null = null;
    this.reset();
    while (true) {
      const pins = yield this.wait({ clk: 'e' });
      const cs = Number(pins[0]),
        clk = Number(pins[1]),
        mosi = Number(pins[2]),
        dc = Number(pins[3]);
      if (cs === 1) {
        this.reset();
        continue;
      }
      if (clk === 1) {
        this.bitStart = this.samplenum;
        if (this.accumBits === 0) this.byteStart = this.samplenum;
        this.currentBit = mosi;
      }
      if (clk !== 0 || this.currentBit === null) continue;

      const bitStart = this.bitStart ?? this.samplenum;
      this.put(bitStart, this.samplenum, this.outAnn, [0, [String(this.currentBit)]]);
      this.accumByte = (this.accumByte << 1) | this.currentBit;
      this.accumBits++;
      if (this.accumBits === 8) {
        const command = dc === 0;
        const value = this.accumByte,
          byteStart = this.byteStart ?? bitStart;
        this.put(byteStart, this.samplenum, this.outAnn, [
          command ? 1 : 2,
          [value.toString(16).toUpperCase().padStart(2, '0')],
        ]);
        if (command) {
          this.putDescription(descriptionStart, descriptionEnd, currentCommand, currentData);
          descriptionStart = byteStart;
          descriptionEnd = this.samplenum;
          currentCommand = value;
          currentData = [];
        } else {
          if (currentData.length < MAX_DATA_LEN) currentData.push(value);
          descriptionEnd = this.samplenum;
        }
        this.accumByte = 0;
        this.accumBits = 0;
        this.byteStart = null;
      }
      this.currentBit = null;
      this.bitStart = null;
    }
  }
}

export default St7735Decoder;
