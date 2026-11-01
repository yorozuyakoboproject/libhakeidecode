import { descriptor } from './descriptor.js';
import {
  Decoder,
  generatorPlugin,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';
import type { DecodeFrame } from '../definition.js';

export type I2CDirection = 'read' | 'write';
export type I2CAddressFormat = 'shifted' | 'unshifted';
export interface I2CFrame extends DecodeFrame {
  kind: 'address' | 'data';
  direction: I2CDirection;
  value: number;
  ack: boolean;
  address: number;
}
export interface I2COptions {
  address_format: I2CAddressFormat;
}
export type I2CProtocolPacket =
  | ['START', repeated: boolean]
  | ['STOP']
  | ['ADDRESS', direction: I2CDirection, address: number, ack: boolean]
  | ['DATA', direction: I2CDirection, value: number, ack: boolean, address: number]
  | ['WARNING', message: string];
export const I2C_ANN = Object.freeze({
  ADDRESS: 0,
  DATA: 1,
  WARNING: 2,
  START: 3,
  STOP: 4,
});

export class I2CDecoder extends Decoder<I2COptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outProtocol = -1;
  private outBinary = -1;
  private outAnn = -1;
  private active = false;
  private firstAddressByte: number | null = null;
  private bits = 0;
  private shift = 0;
  private byteStart: bigint | null = null;
  private activeAddress = 0;
  private direction: I2CDirection = 'write';
  private needAddress = true;

  constructor(options: Partial<I2COptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.active = false;
    this.firstAddressByte = null;
    this.bits = 0;
    this.shift = 0;
    this.byteStart = null;
    this.activeAddress = 0;
    this.direction = 'write';
    this.needAddress = true;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'i2c');
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private frameAddress(address: number, direction: I2CDirection): number {
    if (this.options.address_format === 'unshifted') return address;
    return address * 2 + (direction === 'read' ? 1 : 0);
  }

  private putWarning(message: string, ss = this.samplenum, es = this.samplenum): void {
    this.put(ss, es, this.outAnn, [I2C_ANN.WARNING, [message]]);
    this.put(ss, es, this.outProtocol, ['WARNING', message]);
  }

  private beginCondition(start: bigint): void {
    const repeated = this.active;
    if (this.active && this.bits !== 0)
      this.putWarning('Incomplete byte discarded at a repeated START', this.byteStart ?? start, start);
    this.active = true;
    this.firstAddressByte = null;
    this.bits = 0;
    this.shift = 0;
    this.byteStart = null;
    this.needAddress = true;
    this.put(start, start, this.outAnn, [I2C_ANN.START, [repeated ? 'Repeated START' : 'START']]);
    this.put(start, start, this.outProtocol, ['START', repeated]);
  }

  private endCondition(end: bigint): void {
    if (!this.active) return;
    if (this.bits !== 0) this.putWarning('Incomplete byte discarded at STOP', this.byteStart ?? end, end);
    this.put(end, end, this.outAnn, [I2C_ANN.STOP, ['STOP']]);
    this.put(end, end, this.outProtocol, ['STOP']);
    this.active = false;
    this.bits = 0;
    this.shift = 0;
    this.byteStart = null;
  }

  private emitAddress(ack: boolean, ss: bigint, es: bigint): void {
    const shown = this.frameAddress(this.activeAddress, this.direction),
      wire = this.options.address_format === 'shifted' ? shown : this.activeAddress,
      width = wire > 0xff ? 2 : 1,
      bytes = Uint8Array.from({ length: width }, (_, index) => (wire >>> (8 * (width - index - 1))) & 0xff);
    this.put(ss, es, this.outAnn, [I2C_ANN.ADDRESS, ['Address', ack ? 'ACK' : 'NACK'], shown]);
    this.put(ss, es, this.outProtocol, ['ADDRESS', this.direction, shown, ack]);
    this.put(ss, es, this.outBinary, [this.direction === 'read' ? 0 : 1, bytes]);
  }

  private consumeByte(value: number, ack: boolean, ss: bigint, es: bigint): void {
    if (this.firstAddressByte === null) {
      if ((value & 0xf8) === 0xf0) {
        this.firstAddressByte = value;
        this.activeAddress = (value & 0x06) << 7;
        this.direction = (value & 1) === 1 ? 'read' : 'write';
        return;
      }
      this.activeAddress = value >>> 1;
      this.direction = (value & 1) === 1 ? 'read' : 'write';
      this.emitAddress(ack, ss, es);
      this.needAddress = false;
      return;
    }
    this.firstAddressByte = null;
    this.activeAddress |= value;
    this.emitAddress(ack, ss, es);
    this.needAddress = false;
  }

  private consumeData(value: number, ack: boolean, ss: bigint, es: bigint): void {
    const shownAddress = this.frameAddress(this.activeAddress, this.direction);
    this.put(ss, es, this.outAnn, [I2C_ANN.DATA, ['Data', ack ? 'ACK' : 'NACK'], value]);
    this.put(ss, es, this.outProtocol, ['DATA', this.direction, value, ack, shownAddress]);
    this.put(ss, es, this.outBinary, [this.direction === 'read' ? 2 : 3, Uint8Array.of(value)]);
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let pins = yield this.wait();
    let previousScl = Number(pins[0]),
      previousSda = Number(pins[1]);
    while (true) {
      pins = yield this.wait([{ scl: 'e' }, { sda: 'e' }]);
      const scl = Number(pins[0]),
        sda = Number(pins[1]),
        now = this.samplenum;
      if (sda !== previousSda && scl === 1) {
        if (sda === 0) this.beginCondition(now);
        else this.endCondition(now);
      } else if (scl === 1 && previousScl === 0 && this.active) {
        if (this.bits === 0) this.byteStart = now;
        this.shift = (this.shift << 1) | sda;
        this.bits++;
        if (this.bits === 9) {
          const value = (this.shift >>> 1) & 0xff,
            ack = (this.shift & 1) === 0,
            ss = this.byteStart ?? now;
          this.bits = 0;
          this.shift = 0;
          this.byteStart = null;
          if (this.needAddress) this.consumeByte(value, ack, ss, now);
          else this.consumeData(value, ack, ss, now);
        }
      }
      previousScl = scl;
      previousSda = sda;
    }
  }

  onEof(): void {
    if (this.active && this.bits !== 0)
      this.putWarning('Incomplete byte discarded at end of capture', this.byteStart ?? this.samplenum);
  }
}

export const i2cPlugin: DecoderPlugin<any, any> = {
  decoder: I2CDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(I2CDecoder).createEngine(context),
};

export default I2CDecoder;
