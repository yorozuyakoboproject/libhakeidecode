import { descriptor } from './descriptor.js';
import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';

export type OnewireNetworkPacket = ['RESET/PRESENCE', boolean] | ['ROM', bigint] | ['DATA', number];

type State = 'COMMAND' | 'GET ROM' | 'SEARCH ROM' | 'TRANSPORT' | 'COMMAND ERROR';
type SearchState = 'P' | 'N' | 'D';

const COMMANDS: Readonly<Record<number, readonly [string, State]>> = {
  0x33: ['Read ROM', 'GET ROM'],
  0x0f: ['Conditional read ROM', 'GET ROM'],
  0xcc: ['Skip ROM', 'TRANSPORT'],
  0x55: ['Match ROM', 'GET ROM'],
  0xf0: ['Search ROM', 'SEARCH ROM'],
  0xec: ['Conditional search ROM', 'SEARCH ROM'],
  0x3c: ['Overdrive skip ROM', 'TRANSPORT'],
  0x69: ['Overdrive match ROM', 'GET ROM'],
  0xa5: ['Resume', 'TRANSPORT'],
  0x96: ['DS2408: Disable Test Mode', 'GET ROM'],
};

function hex(value: bigint, digits: number): string {
  return value.toString(16).padStart(digits, '0');
}

export class OnewireNetworkDecoder extends Decoder<Record<string, never>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outProtocol = -1;
  private ssBlock = 0n;
  private esBlock = 0n;
  private state: State = 'COMMAND';
  private bitCount = 0;
  private search: SearchState = 'P';
  private data = 0n;
  private rom = 0n;

  override reset(): void {
    this.ssBlock = 0n;
    this.esBlock = 0n;
    this.state = 'COMMAND';
    this.bitCount = 0;
    this.search = 'P';
    this.data = 0n;
    this.rom = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'onewire_network');
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putAnnotation(texts: readonly string[]): void {
    this.put(this.ssBlock, this.esBlock, this.outAnn, [0, texts]);
  }

  private putPacket(data: OnewireNetworkPacket): void {
    this.put(this.ssBlock, this.esBlock, this.outProtocol, data);
  }

  private collect(length: number, value: number, ss: bigint, es: bigint): boolean {
    if (this.bitCount === 0) this.ssBlock = ss;
    this.data = (this.data & ~(1n << BigInt(this.bitCount))) | (BigInt(value) << BigInt(this.bitCount));
    this.bitCount++;
    if (this.bitCount !== length) return false;
    this.esBlock = es;
    this.data &= (1n << BigInt(length)) - 1n;
    this.bitCount = 0;
    return true;
  }

  private searchRom(length: number, value: number, ss: bigint, es: bigint): boolean {
    if (this.bitCount === 0 && this.search === 'P') this.ssBlock = ss;
    if (this.search === 'P') {
      this.search = 'N';
    } else if (this.search === 'N') {
      this.search = 'D';
    } else {
      this.data = (this.data & ~(1n << BigInt(this.bitCount))) | (BigInt(value) << BigInt(this.bitCount));
      this.search = 'P';
      this.bitCount++;
    }
    if (this.bitCount !== length) return false;
    this.esBlock = es;
    const mask = (1n << BigInt(length)) - 1n;
    this.data &= mask;
    this.search = 'P';
    this.bitCount = 0;
    return true;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    const code = data[0],
      value = data[1];
    if (code === 'RESET/PRESENCE') {
      this.search = 'P';
      this.bitCount = 0;
      this.put(ss, es, this.outAnn, [0, [`Reset/presence: ${value ? 'true' : 'false'}`]]);
      this.put(ss, es, this.outProtocol, ['RESET/PRESENCE', Boolean(value)]);
      this.state = 'COMMAND';
      return;
    }
    if (code !== 'BIT' || (value !== 0 && value !== 1)) return;

    if (this.state === 'COMMAND') {
      if (!this.collect(8, value, ss, es)) return;
      const command = COMMANDS[Number(this.data)];
      this.putAnnotation([`ROM command: 0x${hex(this.data, 2)} '${command ? command[0] : 'unrecognized'}'`]);
      this.state = command ? command[1] : 'COMMAND ERROR';
    } else if (this.state === 'GET ROM') {
      if (!this.collect(64, value, ss, es)) return;
      this.rom = this.data & 0xffffffffffffffffn;
      this.putAnnotation([`ROM: 0x${hex(this.rom, 16)}`]);
      this.putPacket(['ROM', this.rom]);
      this.state = 'TRANSPORT';
    } else if (this.state === 'SEARCH ROM') {
      if (!this.searchRom(64, value, ss, es)) return;
      this.rom = this.data & 0xffffffffffffffffn;
      this.putAnnotation([`ROM: 0x${hex(this.rom, 16)}`]);
      this.putPacket(['ROM', this.rom]);
      this.state = 'TRANSPORT';
    } else if (this.state === 'TRANSPORT') {
      if (!this.collect(8, value, ss, es)) return;
      this.putAnnotation([`Data: 0x${hex(this.data, 2)}`]);
      this.putPacket(['DATA', Number(this.data)]);
    } else if (this.collect(8, value, ss, es)) {
      this.putAnnotation([`ROM error data: 0x${hex(this.data, 2)}`]);
    }
  }
}

export default OnewireNetworkDecoder;
