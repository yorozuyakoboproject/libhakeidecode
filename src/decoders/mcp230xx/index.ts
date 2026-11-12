import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';

export type Mcp230xxType = 'MCP23008' | 'MCP23017';
export interface Mcp230xxOptions extends Record<string, OptionValue> {
  type: Mcp230xxType;
}

const REGISTERS = [
  'IODIR',
  'IPOL',
  'GPINTEN',
  'DEFVAL',
  'INTCON',
  'IOCON',
  'GPPU',
  'INTF',
  'INTCAP',
  'GPIO',
  'OLAT',
] as const;

function buildBank0(): Readonly<Record<number, string>> {
  const registers: Record<number, string> = {};
  for (let index = 0; index < 22; index++) {
    const name = REGISTERS[Math.floor(index / 2)]!;
    registers[index] = name === 'IOCON' ? 'IOCON' : name + (index % 2 === 0 ? 'A' : 'B');
  }
  return registers;
}

function buildBank1(): Readonly<Record<number, string>> {
  const registers: Record<number, string> = {};
  for (let index = 0; index < 22; index++) {
    const name = REGISTERS[index % 11]!;
    registers[index > 11 ? index + 5 : index] = name === 'IOCON' ? 'IOCON' : name + (index >= 11 ? 'B' : 'A');
  }
  return registers;
}

function buildMcp23008(): Readonly<Record<number, string>> {
  return Object.fromEntries(REGISTERS.map((name, index) => [index, name]));
}

const BANK0 = buildBank0();
const BANK1 = buildBank1();
const MCP23008 = buildMcp23008();
type AddressFormat = 'shifted' | 'unshifted';

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function compatibleAddress(address: number): boolean {
  return address >= 0x20 && address <= 0x27;
}

type DataByte = readonly [value: number, ss: bigint, es: bigint];
type State = 'idle' | 'addr' | 'data' | 'read-addr' | 'read-data' | 'stop';

export class Mcp230xxDecoder extends Decoder<Mcp230xxOptions> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: State = 'idle';
  private iocon = 0;
  private ioconSet = false;
  private addressFormat: AddressFormat | null = null;
  private written: DataByte[] = [];
  private read: DataByte[] = [];

  constructor(options: Partial<Mcp230xxOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'idle';
    this.iocon = 0;
    this.ioconSet = false;
    this.addressFormat = null;
    this.written = [];
    this.read = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private registers(): Readonly<Record<number, string>> {
    if (this.options.type === 'MCP23008') return MCP23008;
    return this.iocon & 0x80 ? BANK1 : BANK0;
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private sevenBitAddress(shown: number): number {
    const shifted = shown >>> 1;
    const unshifted = shown & 0x7f;
    if (this.addressFormat === 'shifted') return shifted;
    if (this.addressFormat === 'unshifted') return unshifted;
    if (compatibleAddress(shifted)) {
      this.addressFormat = 'shifted';
      return shifted;
    }
    if (compatibleAddress(unshifted)) this.addressFormat = 'unshifted';
    return unshifted;
  }

  private checkAddress(shown: number, ss: bigint, es: bigint): void {
    const address = this.sevenBitAddress(shown);
    if (!compatibleAddress(address)) this.annotate(ss, es, 2, [`Address ${hex(address)} not MCP230XX compatible`]);
  }

  private handleRead(registerByte: DataByte, data: readonly DataByte[]): void {
    let register = registerByte[0];
    for (const [value, ss, es] of data) {
      const name = this.registers()[register];
      if (name === undefined) {
        this.annotate(ss, es, 2, [`Error: Register ${register} not accessible`]);
        if (!this.ioconSet) this.iocon = value;
      } else {
        if (name === 'IOCON') {
          this.iocon = value;
          this.ioconSet = true;
        }
        this.annotate(ss, es, 0, [`Read ${name}: ${hex(value)}`, `R${hex(value)}`]);
      }
      register++;
    }
  }

  private handleWrite(data: readonly DataByte[]): void {
    if (data.length < 2) return;
    let register = data[0]![0];
    for (let index = 1; index < data.length; index++) {
      const [value, ss, es] = data[index]!;
      const name = this.registers()[register];
      if (name === undefined) {
        this.annotate(ss, es, 2, [`Error: Register ${register} not accessible`]);
        if (!this.ioconSet) this.iocon = value;
      } else {
        if (name === 'IOCON') {
          this.iocon = value;
          this.ioconSet = true;
        }
        this.annotate(ss, es, 1, [`Write ${name}: ${hex(value)}`, `W${hex(value)}`]);
      }
      register++;
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    switch (data[0]) {
      case 'START':
        if (data[1] !== true && this.state === 'idle') {
          this.state = 'addr';
          this.written = [];
          this.read = [];
        } else if (data[1] === true && this.state === 'stop') {
          this.state = 'read-addr';
        }
        return;
      case 'ADDRESS':
        if (this.state === 'addr' && data[1] === 'write') {
          this.state = 'data';
          if (typeof data[2] === 'number') this.checkAddress(data[2], ss, es);
        } else if (this.state === 'read-addr' && data[1] === 'read') {
          this.state = 'read-data';
          if (typeof data[2] === 'number') this.checkAddress(data[2], ss, es);
        }
        return;
      case 'DATA':
        if ((this.state === 'data' || this.state === 'stop') && data[1] === 'write' && typeof data[2] === 'number') {
          this.state = 'stop';
          this.written.push([data[2], ss, es]);
        } else if (
          (this.state === 'read-data' || this.state === 'stop') &&
          data[1] === 'read' &&
          typeof data[2] === 'number'
        ) {
          this.state = 'stop';
          this.read.push([data[2], ss, es]);
        }
        return;
      case 'STOP':
        if (this.state !== 'stop') return;
        this.state = 'idle';
        if (this.read.length > 0 && this.written.length === 1) this.handleRead(this.written[0]!, this.read);
        else if (this.written.length > 0 && this.read.length === 0) this.handleWrite(this.written);
        return;
      default:
        return;
    }
  }
}

export default Mcp230xxDecoder;
