import { Decoder, OUTPUT_ANN, OUTPUT_LOGIC } from '../../libhakeidecode/index.js';
import type { DecoderContext, EofInfo } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type State = 'idle' | 'get-address' | 'read' | 'write';
type AddressFormat = 'shifted' | 'unshifted';

interface StartPacket {
  readonly 0: 'START';
  readonly 1: boolean;
}

interface StopPacket {
  readonly 0: 'STOP';
}

interface AddressPacket {
  readonly 0: 'ADDRESS';
  readonly 1: 'read' | 'write';
  readonly 2: number;
  readonly 3: boolean;
}

interface DataPacket {
  readonly 0: 'DATA';
  readonly 1: 'read' | 'write';
  readonly 2: number;
  readonly 3: boolean;
  readonly 4: number;
}

type I2CPacket = StartPacket | StopPacket | AddressPacket | DataPacket | readonly ['WARNING', string];

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

export class Pca9571Decoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outLogic = -1;
  private state: State = 'idle';
  private lastWrite = 0xff;
  private lastWriteEs = 0n;
  private ss = 0n;
  private es = 0n;
  private addressFormat: AddressFormat | null = null;
  private eof = false;

  override reset(): void {
    this.state = 'idle';
    this.lastWrite = 0xff;
    this.lastWriteEs = 0n;
    this.ss = 0n;
    this.es = 0n;
    this.addressFormat = null;
    this.eof = false;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outLogic = this.register(OUTPUT_LOGIC);
  }

  onEof(info: EofInfo): void {
    this.es = info.sample;
    this.eof = true;
    this.putLogicStates();
  }

  flush(): void {
    if (this.eof) this.putLogicStates();
  }

  private putAnnotation(classIndex: number, texts: readonly string[], ss = this.ss, es = this.es): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putLogicStates(): void {
    if (this.es <= this.lastWriteEs) return;
    this.put(this.lastWriteEs, this.es, this.outLogic, [0, Uint8Array.of(this.lastWrite)]);
    this.lastWriteEs = this.es;
  }

  private normalizeAddress(shown: number): number | null {
    const shifted = shown >>> 1;
    if (this.addressFormat === 'shifted') return shifted === 0x25 ? shifted : null;
    if (this.addressFormat === 'unshifted') return (shown & 0x7f) === 0x25 ? shown & 0x7f : null;
    if (shifted === 0x25) {
      this.addressFormat = 'shifted';
      return shifted;
    }
    if ((shown & 0x7f) === 0x25) {
      this.addressFormat = 'unshifted';
      return shown & 0x7f;
    }
    return null;
  }

  private shownSevenBitAddress(shown: number): number {
    if (this.addressFormat === 'unshifted') return shown & 0x7f;
    return shown >>> 1;
  }

  private checkChip(shown: number): number | null {
    const chip = this.normalizeAddress(shown);
    if (chip !== null) return chip;
    const address = this.shownSevenBitAddress(shown);
    this.putAnnotation(2, [`Warning: I²C slave 0x${hex(address)} not a PCA9571 compatible chip.`]);
    return null;
  }

  private handleIo(value: number): void {
    if (this.state === 'read') {
      if (value !== this.lastWrite)
        this.putAnnotation(2, [`Warning: read value and last write value (${hex(this.lastWrite)}) are different`]);
      this.putAnnotation(1, [`Outputs read: ${hex(value)}`, `R: ${hex(value)}`]);
      return;
    }
    this.putLogicStates();
    this.lastWrite = value;
    this.putAnnotation(1, [`Outputs set: ${hex(value)}`, `W: ${hex(value)}`]);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    const packet = data as unknown as I2CPacket;
    this.ss = ss;
    this.es = es;

    switch (packet[0]) {
      case 'START':
        this.state = 'get-address';
        return;
      case 'STOP':
        this.state = 'idle';
        return;
      case 'WARNING':
        return;
      case 'ADDRESS': {
        if (this.state !== 'get-address' || this.checkChip(packet[2]) === null) {
          this.state = 'idle';
          return;
        }
        this.state = packet[1] === 'read' ? 'read' : 'write';
        if (!packet[3]) this.state = 'idle';
        return;
      }
      case 'DATA':
        if (this.state !== 'read' && this.state !== 'write') {
          this.state = 'idle';
          return;
        }
        this.handleIo(packet[2]);
        if (!packet[3]) this.state = 'idle';
    }
  }
}

export default Pca9571Decoder;
