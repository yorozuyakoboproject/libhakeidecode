import { Decoder } from '../../libhakeidecode/index.js';
import { OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

interface SpiWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly mosi: number | null;
  readonly cs: boolean | null;
}

function spiWord(ss: bigint, es: bigint, data: unknown): SpiWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const mosi = data[1];
  const cs = data[3];
  if (mosi !== null && (typeof mosi !== 'number' || !Number.isInteger(mosi) || mosi < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, mosi, cs };
}

function wireBytes(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  for (let remainder = value; remainder > 0; remainder = Math.floor(remainder / 256)) bytes.unshift(remainder & 0xff);
  return bytes;
}

function decodeRegister(register: number, value: number): { name: string; text: string | number } | null {
  if (register >= 1 && register <= 8)
    return { name: `Digit ${register}`, text: value.toString(16).toUpperCase().padStart(2, '0') };
  if (register === 0x00) return { name: 'No-op', text: '' };
  if (register === 0x09) return { name: 'Decode', text: `0b${value.toString(2).padStart(8, '0')}` };
  if (register === 0x0a) {
    const intensity = value & 0x0f;
    return { name: 'Intensity', text: intensity === 0 ? 'min' : intensity === 15 ? 'max' : intensity };
  }
  if (register === 0x0b) return { name: 'Scan limit', text: 1 + value };
  if (register === 0x0c) return { name: 'Shutdown', text: value ? 'off' : 'on' };
  if (register === 0x0f) return { name: 'Display test', text: value ? 'on' : 'off' };
  return null;
}

export class Max72xxDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private position = 0;
  private csStart = 0n;
  private lastEs = 0n;
  private csAsserted = false;
  private numDrivers = 1;
  private registerNumber = 0;
  private registerStart = 0n;

  override reset(): void {
    this.position = 0;
    this.csStart = 0n;
    this.lastEs = 0n;
    this.csAsserted = false;
    this.registerNumber = 0;
    this.registerStart = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.numDrivers = Math.max(1, Math.trunc(Number(this.options.numofdrivers)));
  }

  private warn(ss: bigint, es: bigint, message: string): void {
    this.put(ss, es, this.outAnn, [3, [message]]);
  }

  private finishChipSelect(es: bigint): void {
    const count = this.position;
    if (count > 0 && count < this.numDrivers * 2)
      this.warn(this.csStart, es, 'Not enough bits sent for current number of chips');
    else if (count > this.numDrivers * 2) this.warn(this.csStart, es, 'Too many bits sent for current number of chips');
    this.position = 0;
  }

  private processByte(ss: bigint, es: bigint, value: number): void {
    if (this.position <= this.numDrivers * 2) {
      if (this.position % 2 === 0) {
        this.registerNumber = value;
        this.registerStart = ss;
      } else {
        if (this.numDrivers > 1)
          this.put(this.registerStart, es, this.outAnn, [0, [`Chip ${Math.floor(this.position / 2) + 1}`]]);
        if (this.registerNumber >= 1 && this.registerNumber <= 8) {
          this.put(this.registerStart, es, this.outAnn, [
            2,
            [`Digit ${this.registerNumber}: ${value.toString(16).toUpperCase().padStart(2, '0')}`],
          ]);
        } else {
          const register = decodeRegister(this.registerNumber, value);
          if (register) {
            const text =
              register.text === ''
                ? value
                  ? `${register.name}: `
                  : register.name
                : `${register.name}: ${register.text}`;
            this.put(this.registerStart, es, this.outAnn, [1, [text]]);
          } else {
            this.warn(
              this.registerStart,
              es,
              `Unknown register ${this.registerNumber.toString(16).toUpperCase().padStart(2, '0')}`,
            );
          }
        }
      }
    }
    this.position++;
    this.lastEs = es;
    if (this.position >= this.numDrivers * 2) {
      this.position = 0;
      this.csStart = es;
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const word = spiWord(ss, es, data);
    if (!word) return;
    if (word.cs !== null) {
      if (!word.cs) {
        if (this.csAsserted) this.finishChipSelect(es);
        this.csAsserted = false;
        this.lastEs = es;
        return;
      }
      if (!this.csAsserted) {
        this.position = 0;
        this.csStart = ss;
      }
      this.csAsserted = true;
    } else if (this.position === 0) {
      this.csStart = ss;
    }
    if (word.mosi !== null) for (const byte of wireBytes(word.mosi)) this.processByte(ss, es, byte);
    this.lastEs = es;
  }

  onEof(): void {
    if (this.position > 0) this.finishChipSelect(this.lastEs);
  }
}

export default Max72xxDecoder;
