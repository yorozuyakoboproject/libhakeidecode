import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface SpiWord {
  readonly ss: bigint;
  readonly es: bigint;
  readonly mosi: number | null;
  readonly miso: number | null;
  readonly cs: boolean | null;
}

interface Command {
  readonly name: string;
  readonly annotation: number;
  readonly read: boolean;
}

const COMMANDS: Readonly<Record<number, Command>> = {
  0x80: { name: 'WRDS', annotation: 0, read: false },
  0x81: { name: 'STO', annotation: 1, read: false },
  0x82: { name: 'SLEEP', annotation: 2, read: false },
  0x83: { name: 'WRITE', annotation: 3, read: false },
  0x84: { name: 'WREN', annotation: 4, read: false },
  0x85: { name: 'RCL', annotation: 5, read: false },
  0x86: { name: 'READ', annotation: 6, read: true },
  0x87: { name: 'READ', annotation: 6, read: true },
};

function spiWord(ss: bigint, es: bigint, data: unknown): SpiWord | null {
  if (!Array.isArray(data) || data.length !== 5 || data[0] !== 'WORD') return null;
  const mosi = data[1];
  const miso = data[2];
  const cs = data[3];
  if (mosi !== null && (typeof mosi !== 'number' || !Number.isInteger(mosi) || mosi < 0)) return null;
  if (miso !== null && (typeof miso !== 'number' || !Number.isInteger(miso) || miso < 0)) return null;
  if (cs !== null && typeof cs !== 'boolean') return null;
  return { ss, es, mosi, miso, cs };
}

export class X2444mDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private words: SpiWord[] = [];

  override reset(): void {
    this.words = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.reset();
  }

  private flushFrame(es: bigint): void {
    if (!this.words.length) return;
    const first = this.words[0]!;
    const address = first.mosi;
    if (address === null) {
      this.words = [];
      return;
    }
    const command = COMMANDS[address & 0x87];
    if (!command) {
      this.words = [];
      return;
    }
    const ss = first.ss;
    if (this.words.length === 1) {
      this.put(ss, es, this.outAnn, [command.annotation, [command.name, command.name[0]]]);
    } else {
      let readValue = 0;
      let writeValue = 0;
      for (const word of this.words.slice(1)) {
        readValue = readValue * 256 + (word.miso ?? 0);
        writeValue = writeValue * 256 + (word.mosi ?? 0);
      }
      const value = command.read ? readValue : command.name === 'WRITE' ? writeValue : 0;
      const shownAddress = (address >> 3) & 0x0f;
      const addressText = command.name === 'READ' || command.name === 'WRITE' ? `0x${shownAddress.toString(16)}` : '';
      const valueText = `0x${value.toString(16).padStart(4, '0')}`;
      this.put(ss, es, this.outAnn, [
        command.annotation,
        [
          `${command.name}: ${addressText} => ${valueText}`,
          `${command.name[0]}: ${addressText} => ${valueText}`,
          command.name[0],
        ],
      ]);
    }
    this.words = [];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (Array.isArray(data) && data[0] === 'WARNING') {
      this.flushFrame(this.samplenum);
      return;
    }
    const word = spiWord(ss, es, data);
    if (!word) return;
    if (this.words.length && word.cs === false) this.flushFrame(word.ss);
    this.words.push(word);
    const address = this.words[0]!.mosi;
    const command = address === null ? undefined : COMMANDS[address & 0x87];
    const expected = command?.name === 'READ' || command?.name === 'WRITE' ? 3 : 1;
    if (this.words.length >= expected) this.flushFrame(word.es);
  }

  onEof(): void {
    this.flushFrame(this.words.at(-1)?.es ?? this.samplenum);
  }
}

export default X2444mDecoder;
