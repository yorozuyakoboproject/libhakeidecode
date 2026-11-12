import { Decoder, OUTPUT_ANN, OUTPUT_LOGIC } from '../../libhakeidecode/index.js';
import type { DecoderContext, EofInfo } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

type State = 'idle' | 'get-address' | 'get-register' | 'write' | 'read' | 'read-data';
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

export class Tca6408aDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outLogic = -1;
  private state: State = 'idle';
  private registerAddress = 0;
  private logicValue = 0;
  private logicOutputEs = 0n;
  private ss = 0n;
  private es = 0n;
  private addressFormat: AddressFormat | null = null;
  private eof = false;

  override reset(): void {
    this.state = 'idle';
    this.registerAddress = 0;
    this.logicValue = 0;
    this.logicOutputEs = 0n;
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

  private putAnnotation(classIndex: number, texts: readonly string[]): void {
    this.put(this.ss, this.es, this.outAnn, [classIndex, texts]);
  }

  private putLogicStates(): void {
    if (this.es <= this.logicOutputEs) return;
    this.put(this.logicOutputEs, this.es, this.outLogic, [0, Uint8Array.of(this.logicValue)]);
    this.logicOutputEs = this.es;
  }

  private normalizeAddress(shown: number): number | null {
    const shifted = shown >>> 1;
    const unshifted = shown & 0x7f;
    if (this.addressFormat === 'shifted') return shifted === 0x20 || shifted === 0x21 ? shifted : null;
    if (this.addressFormat === 'unshifted') return unshifted === 0x20 || unshifted === 0x21 ? unshifted : null;
    if (shifted === 0x20 || shifted === 0x21) {
      this.addressFormat = 'shifted';
      return shifted;
    }
    if (unshifted === 0x20 || unshifted === 0x21) {
      this.addressFormat = 'unshifted';
      return unshifted;
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
    this.putAnnotation(2, [`Warning: I²C slave 0x${hex(address)} not a TCA6408A compatible chip.`]);
    return null;
  }

  private handleWriteRegister(value: number): void {
    const texts = [
      ['Input port', 'In', 'I'],
      ['Output port', 'Out', 'O'],
      ['Polarity inversion register', 'Pol', 'P'],
      ['Configuration register', 'Conf', 'C'],
    ][value];
    if (texts) this.putAnnotation(0, texts);
  }

  private handleRegister(value: number): void {
    switch (this.registerAddress) {
      case 0:
        this.putAnnotation(1, [`State of inputs: ${hex(value)}`]);
        return;
      case 1:
        this.putLogicStates();
        this.putAnnotation(1, [`Outputs set: ${hex(value)}`]);
        this.logicValue = value;
        return;
      case 2:
        this.putAnnotation(1, [`Polarity inverted: ${hex(value)}`]);
        return;
      case 3:
        this.putAnnotation(1, [`Configuration: ${hex(value)}`]);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data) || typeof data[0] !== 'string') return;
    const packet = data as unknown as I2CPacket;
    this.ss = ss;
    this.es = es;

    switch (packet[0]) {
      case 'START':
        if (packet[1]) {
          if (this.state === 'write') this.state = 'read';
        } else if (this.state === 'idle') {
          this.state = 'get-address';
        }
        return;
      case 'STOP':
        this.state = 'idle';
        return;
      case 'WARNING':
        return;
      case 'ADDRESS':
        if (this.state === 'get-address') {
          if (this.checkChip(packet[2]) === null) return;
          this.state = 'get-register';
          if (!packet[3]) this.state = 'idle';
        } else if (this.state === 'read' && packet[1] === 'read') {
          this.state = 'read-data';
          if (!packet[3]) this.state = 'idle';
        }
        return;
      case 'DATA':
        if (this.state === 'get-register' && packet[1] === 'write') {
          this.registerAddress = packet[2];
          this.handleWriteRegister(this.registerAddress);
          this.state = 'write';
        } else if (this.state === 'write' || this.state === 'read-data') {
          this.handleRegister(packet[2]);
        } else {
          return;
        }
        if (!packet[3]) this.state = 'idle';
    }
  }
}

export default Tca6408aDecoder;
