import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';

const COMMANDS: Readonly<Record<number, string>> = {
  0xf0: 'Read PIO Registers',
  0xf5: 'Channel Access Read',
  0x5a: 'Channel Access Write',
  0xcc: 'Write Conditional Search Register',
  0xc3: 'Reset Activity Latches',
  0x3c: 'Disable Test Mode',
};

function hex(value: number, digits: number): string {
  return value.toString(16).toLowerCase().padStart(digits, '0');
}

export class Ds2408Decoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private ss = 0n;
  private es = 0n;
  private bytes: number[] = [];

  override reset(): void {
    this.ss = 0n;
    this.es = 0n;
    this.bytes = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putx(texts: readonly string[]): void {
    this.put(this.ss, this.es, this.outAnn, [0, texts]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    const code = data[0],
      value = data[1];
    if (code === 'RESET/PRESENCE') {
      this.ss = ss;
      this.es = es;
      this.putx([`Reset/presence: ${value ? 'true' : 'false'}`]);
      this.bytes = [];
    } else if (code === 'ROM' && typeof value === 'bigint') {
      this.ss = ss;
      this.es = es;
      const family = Number(value & 0xffn);
      this.putx([`ROM: 0x${value.toString(16).padStart(16, '0')} (family code 0x${hex(family, 2)})`]);
      this.bytes = [];
    } else if (code === 'DATA' && typeof value === 'number') {
      this.bytes.push(value);
      if (this.bytes.length === 1) {
        this.ss = ss;
        this.es = es;
        const command = COMMANDS[value];
        this.putx([command ? `${command} (0x${hex(value, 2)})` : `Unrecognized command: 0x${hex(value, 2)}`]);
      } else if (this.bytes[0] === 0xf0) {
        if (this.bytes.length === 2) {
          this.ss = ss;
        } else if (this.bytes.length === 3) {
          this.es = es;
          this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
        } else {
          this.ss = ss;
          this.es = es;
          this.putx([`Data: 0x${hex(this.bytes.at(-1)!, 2)}`]);
        }
      } else if (this.bytes[0] === 0xf5) {
        if (this.bytes.length === 2) {
          this.ss = ss;
        } else {
          this.ss = ss;
          this.es = es;
          this.putx([`PIO sample: 0x${hex(this.bytes.at(-1)!, 2)}`]);
        }
      } else if (this.bytes[0] === 0x5a) {
        if (this.bytes.length === 2) {
          this.ss = ss;
        } else if (this.bytes.length === 3) {
          this.es = es;
          if (this.bytes.at(-1) === (this.bytes.at(-2)! ^ 0xff)) {
            this.putx([
              `Data: 0x${hex(this.bytes.at(-2)!, 2)} (bit-inversion correct: 0x${hex(this.bytes.at(-1)!, 2)})`,
            ]);
          } else {
            this.putx([
              `Data error: second byte (0x${hex(this.bytes.at(-1)!, 2)}) is not bit-inverse of first (0x${hex(this.bytes.at(-2)!, 2)})`,
            ]);
          }
        } else {
          this.ss = ss;
          this.es = es;
          if (this.bytes.at(-1) === 0xaa) this.putx(['Success']);
          else if (this.bytes.at(-1) === 0xff) this.putx(['Fail New State']);
        }
      } else if (this.bytes[0] === 0xcc) {
        if (this.bytes.length === 2) {
          this.ss = ss;
        } else if (this.bytes.length === 3) {
          this.es = es;
          this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
        } else {
          this.ss = ss;
          this.es = es;
          this.putx([`Data: 0x${hex(this.bytes.at(-1)!, 2)}`]);
        }
      } else if (this.bytes[0] === 0xc3) {
        if (this.bytes.length === 2) {
          this.ss = ss;
        } else {
          this.ss = ss;
          this.es = es;
          this.putx([this.bytes.at(-1) === 0xaa ? 'Success' : 'Invalid byte']);
        }
      }
    }
  }
}

export default Ds2408Decoder;
