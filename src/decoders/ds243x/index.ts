import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';

const COMMANDS_2432: Readonly<Record<number, string>> = {
  0x0f: 'Write scratchpad',
  0xaa: 'Read scratchpad',
  0x55: 'Copy scratchpad',
  0xf0: 'Read memory',
  0x5a: 'Load first secret',
  0x33: 'Compute next secret',
  0xa5: 'Read authenticated page',
};

const COMMANDS_2433: Readonly<Record<number, string>> = {
  0x0f: 'Write scratchpad',
  0xaa: 'Read scratchpad',
  0x55: 'Copy scratchpad',
  0xf0: 'Read memory',
};

const FAMILIES: Readonly<Record<number, readonly [string, Readonly<Record<number, string>>]>> = {
  0x33: ['DS2432', COMMANDS_2432],
  0x23: ['DS2433', COMMANDS_2433],
};

function hex(value: number, digits: number): string {
  return value.toString(16).toLowerCase().padStart(digits, '0');
}

function bytesText(bytes: readonly number[]): string {
  return bytes.map((byte) => `0x${hex(byte, 2)}`).join(',');
}

function crc16(bytes: readonly number[]): number {
  const reverse = 0xa001;
  let crc = 0;
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      if (((byte ^ crc) & 1) !== 0) crc = (crc >>> 1) ^ reverse;
      else crc >>>= 1;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

export class Ds243xDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private ss = 0n;
  private es = 0n;
  private bytes: number[] = [];
  private familyCode: number | null = null;
  private family = '';
  private commands: Readonly<Record<number, string>> = COMMANDS_2432;

  override reset(): void {
    this.ss = 0n;
    this.es = 0n;
    this.bytes = [];
    this.familyCode = null;
    this.family = '';
    this.commands = COMMANDS_2432;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
  }

  private putx(texts: readonly string[]): void {
    this.put(this.ss, this.es, this.outAnn, [0, texts]);
  }

  private crcText(bytes: readonly number[], expected: number): string {
    return `CRC: ${crc16(bytes) === expected ? 'ok' : 'error'}`;
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
      return;
    }
    if (code === 'ROM' && typeof value === 'bigint') {
      this.ss = ss;
      this.es = es;
      this.familyCode = Number(value & 0xffn);
      const known = FAMILIES[this.familyCode];
      if (known) {
        [this.family, this.commands] = known;
      }
      const details = known
        ? `family code is 0x${hex(this.familyCode, 2)}, ${this.family} detected`
        : `family code 0x${hex(this.familyCode, 2)} unknown`;
      this.putx([
        `ROM: 0x${value.toString(16).padStart(16, '0')} (${details})`,
        `ROM: 0x${value.toString(16).padStart(16, '0')} (${this.family})`,
      ]);
      this.bytes = [];
      return;
    }
    if (code !== 'DATA' || typeof value !== 'number') return;

    this.bytes.push(value);
    const length = this.bytes.length,
      command = this.bytes[0]!,
      last = this.bytes.at(-1)!;
    if (length === 1) {
      this.ss = ss;
      this.es = es;
      const name = this.commands[value];
      this.putx([name ? `Function command: ${name} (0x${hex(value, 2)})` : `Unrecognized command: 0x${hex(value, 2)}`]);
      return;
    }
    if (command === 0x0f) {
      if (length === 2) this.ss = ss;
      else if (length === 3) {
        this.es = es;
        this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
      } else if (length === 4) this.ss = ss;
      else if (length === 11) {
        this.es = es;
        this.putx([`Data: ${bytesText(this.bytes.slice(3, 11))}`]);
      } else if (length === 12) this.ss = ss;
      else if (length === 13) {
        this.es = es;
        this.putx([this.crcText(this.bytes.slice(0, 11), this.bytes[11]! + (this.bytes[12]! << 8))]);
      }
    } else if (command === 0xaa) {
      if (length === 2) this.ss = ss;
      else if (length === 3) {
        this.es = es;
        this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
      } else if (length === 4) {
        this.ss = ss;
        this.es = es;
        this.putx([`Data status (E/S): 0x${hex(this.bytes[3]!, 2)}`]);
      } else if (length === 5) this.ss = ss;
      else if (length === 12) {
        this.es = es;
        this.putx([`Data: ${bytesText(this.bytes.slice(4, 12))}`]);
      } else if (length === 13) this.ss = ss;
      else if (length === 14) {
        this.es = es;
        this.putx([this.crcText(this.bytes.slice(0, 12), this.bytes[12]! + (this.bytes[13]! << 8))]);
      }
    } else if (command === 0x5a) {
      if (length === 2) this.ss = ss;
      else if (length === 4) {
        this.es = es;
        this.putx([`Authorization pattern (TA1, TA2, E/S): ${bytesText(this.bytes.slice(1, 4))}`]);
      } else if (length > 4) {
        this.ss = ss;
        this.es = es;
        if (last === 0xaa || last === 0x55) this.putx(['End of operation']);
      }
    } else if (command === 0x33) {
      if (length === 2) this.ss = ss;
      else if (length === 3) {
        this.es = es;
        this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
      } else if (length > 3) {
        this.ss = ss;
        this.es = es;
        if (last === 0xaa || last === 0x55) this.putx(['End of operation']);
      }
    } else if (command === 0x55) {
      if (length === 2) this.ss = ss;
      else if (length === 4) {
        this.es = es;
        this.putx([`Authorization pattern (TA1, TA2, E/S): ${bytesText(this.bytes.slice(1, 4))}`]);
      } else if (length === 5) this.ss = ss;
      else if (length === 24) {
        this.es = es;
        const mac = bytesText(this.bytes.slice(4, 24));
        this.putx([`Message authentication code: ${mac}`, `MAC: ${mac}`]);
      } else if (length > 24) {
        this.ss = ss;
        this.es = es;
        if (last === 0xaa || last === 0x55) this.putx(['Operation succeeded']);
        else if (last === 0) this.putx(['Operation failed']);
      }
    } else if (command === 0xa5) {
      if (length === 2) this.ss = ss;
      else if (length === 3) {
        this.es = es;
        this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
      } else if (length === 4) this.ss = ss;
      else if (length === 35) {
        this.es = es;
        this.putx([`Data: ${bytesText(this.bytes.slice(3, 35))}`]);
      } else if (length === 36) {
        this.ss = ss;
        this.es = es;
        this.putx([`Padding: ${last === 0xff ? 'ok' : 'error'}`]);
      } else if (length === 37) this.ss = ss;
      else if (length === 38) {
        this.es = es;
        this.putx([this.crcText(this.bytes.slice(0, 36), this.bytes[36]! + (this.bytes[37]! << 8))]);
      } else if (length === 39) this.ss = ss;
      else if (length === 58) {
        this.es = es;
        const mac = bytesText(this.bytes.slice(38, 58));
        this.putx([`Message authentication code: ${mac}`, `MAC: ${mac}`]);
      } else if (length === 59) this.ss = ss;
      else if (length === 60) {
        this.es = es;
        this.putx([this.crcText(this.bytes.slice(38, 58), this.bytes[58]! + (this.bytes[59]! << 8))]);
      } else if (length > 60) {
        this.ss = ss;
        this.es = es;
        if (last === 0xaa || last === 0x55) this.putx(['Operation completed']);
      }
    } else if (command === 0xf0) {
      if (length === 2) this.ss = ss;
      else if (length === 3) {
        this.es = es;
        this.putx([`Target address: 0x${hex((this.bytes[2]! << 8) + this.bytes[1]!, 4)}`]);
      } else if (length > 3) {
        this.ss = ss;
        this.es = es;
        this.putx([`Data: 0x${hex(last, 2)}`]);
        this.put(this.ss, this.es, this.outBinary, [0, Uint8Array.of(last)]);
      }
    }
  }
}

export default Ds243xDecoder;
