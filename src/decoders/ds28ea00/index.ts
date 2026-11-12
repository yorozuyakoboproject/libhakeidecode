import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';

const COMMANDS: Readonly<Record<number, string>> = {
  0x4e: 'Write scratchpad',
  0xbe: 'Read scratchpad',
  0x48: 'Copy scratchpad',
  0x44: 'Convert temperature',
  0xb4: 'Read power mode',
  0xb8: 'Recall EEPROM',
  0xf5: 'PIO access read',
  0xa5: 'PIO access write',
  0x99: 'Chain',
};

function hex(value: number, digits: number): string {
  return value.toString(16).toLowerCase().padStart(digits, '0');
}

export class Ds28ea00Decoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private ss = 0n;
  private es = 0n;
  private state = 'ROM';

  override reset(): void {
    this.ss = 0n;
    this.es = 0n;
    this.state = 'ROM';
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
    this.ss = ss;
    this.es = es;
    if (code === 'RESET/PRESENCE') {
      this.putx([`Reset/presence: ${value ? 'true' : 'false'}`]);
      this.state = 'ROM';
    } else if (code === 'ROM' && typeof value === 'bigint') {
      this.putx([`ROM: 0x${value.toString(16).padStart(16, '0')}`]);
      this.state = 'COMMAND';
    } else if (code === 'DATA' && typeof value === 'number') {
      if (this.state === 'COMMAND') {
        const command = COMMANDS[value];
        if (!command) {
          this.putx([`Unrecognized command: 0x${hex(value, 2)}`]);
          return;
        }
        this.putx([`Function command: 0x${hex(value, 2)} '${command}'`]);
        this.state = command.toUpperCase();
      } else if (this.state === 'READ SCRATCHPAD') {
        this.putx([`Scratchpad data: 0x${hex(value, 2)}`]);
      } else if (this.state === 'CONVERT TEMPERATURE') {
        this.putx([`Temperature conversion status: 0x${hex(value, 2)}`]);
      } else if (Object.values(COMMANDS).some((command) => command.toUpperCase() === this.state)) {
        this.putx([`TODO '${this.state}': 0x${hex(value, 2)}`]);
      }
    }
  }
}

export default Ds28ea00Decoder;
