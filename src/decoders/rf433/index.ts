import { descriptor } from './descriptor.js';
import {
  Decoder,
  generatorPlugin,
  OUTPUT_ANN,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';
import type { DecodeFrame } from '../definition.js';

export interface RF433Options {
  encoding: 'ev1527' | 'pt2262';
}
export interface RF433Frame extends DecodeFrame {
  encoding: 'ev1527' | 'pt2262';
  address: number;
  button: number;
  code: number;
  valid: boolean;
}
export type RF433ProtocolPacket = ['FRAME', frame: Omit<RF433Frame, 'ss' | 'es'>] | ['WARNING', message: string];
export const RF433_ANN = Object.freeze({ FRAME: 0, WARNING: 1 });

function base3(digits: readonly number[]): number {
  let value = 0;
  for (const digit of digits) value = value * 3 + digit;
  return value;
}

export class RF433Decoder extends Decoder<RF433Options> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outProtocol = -1;
  private outAnn = -1;
  private unit = 0;
  private active = false;
  private packetStart: bigint | null = null;
  private values: number[] = [];
  private valid = true;
  private lastHigh = 0;
  private lastHighStart: bigint | null = null;

  constructor(options: Partial<RF433Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.unit = 0;
    this.active = false;
    this.packetStart = null;
    this.values = [];
    this.valid = true;
    this.lastHigh = 0;
    this.lastHighStart = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'rf433');
    this.outAnn = this.register(OUTPUT_ANN);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private warning(message: string): void {
    this.put(this.samplenum, this.samplenum, this.outAnn, [RF433_ANN.WARNING, [message]]);
    this.put(this.samplenum, this.samplenum, this.outProtocol, ['WARNING', message]);
  }

  private updateUnit(samples: number): void {
    if (samples < 1) return;
    if (this.unit && samples < this.unit * 0.5) return;
    if (!this.unit || samples < this.unit) this.unit = samples;
  }

  private isSync(high: number, low: number): boolean {
    return !!this.unit && high <= this.unit * 2.25 && low >= this.unit * 7;
  }

  private startPacket(highStart: bigint): void {
    if (this.active && this.values.length) this.warning('Incomplete RF packet discarded during resynchronization');
    this.active = true;
    this.packetStart = highStart;
    this.values = [];
    this.valid = true;
  }

  private emitPacket(es: bigint): void {
    const encoding = this.options.encoding;
    let frame: Omit<RF433Frame, 'ss' | 'es'>;
    if (encoding === 'ev1527') {
      let code = 0;
      for (const bit of this.values) code = code * 2 + bit;
      frame = {
        encoding,
        address: code >>> 4,
        button: code & 0x0f,
        code,
        valid: this.valid,
      };
    } else {
      const address = base3(this.values.slice(0, 8)),
        button = base3(this.values.slice(8, 12)),
        code = base3(this.values);
      frame = { encoding, address, button, code, valid: this.valid };
    }
    this.put(this.packetStart ?? es, es, this.outAnn, [
      RF433_ANN.FRAME,
      [frame.valid ? 'RF packet' : 'Invalid RF packet', frame.code.toString(16).toUpperCase()],
    ]);
    this.put(this.packetStart ?? es, es, this.outProtocol, ['FRAME', frame]);
    this.active = false;
    this.packetStart = null;
    this.values = [];
  }

  private consumePair(high: number, low: number, highStart: bigint, es: bigint): void {
    if (!(high > 0) || !(low > 0)) return;
    this.updateUnit(high);
    this.updateUnit(low);
    if (this.isSync(high, low)) {
      this.startPacket(highStart);
      return;
    }
    if (!this.active || !this.unit) return;
    const highUnits = high / this.unit,
      lowUnits = low / this.unit;
    if (low >= this.unit * 7) {
      this.startPacket(highStart);
      return;
    }
    if (highUnits > 5.5 || lowUnits > 5.5) {
      this.warning('Invalid RF pulse rejected');
      this.active = false;
      this.values = [];
      return;
    }
    const highLong = highUnits >= 1.75,
      lowLong = lowUnits >= 1.75;
    if (this.options.encoding === 'pt2262') {
      if (highLong && !lowLong) this.values.push(1);
      else if (!highLong && lowLong) this.values.push(0);
      else if (!highLong && !lowLong) this.values.push(2);
      else {
        this.values.push(2);
        this.valid = false;
      }
      if (this.values.length === 12) this.emitPacket(es);
    } else {
      if (highLong && !lowLong) this.values.push(1);
      else if (!highLong && lowLong) this.values.push(0);
      else {
        this.values.push(0);
        this.valid = false;
      }
      if (this.values.length === 24) this.emitPacket(es);
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let pins = yield this.wait();
    let level = Number(pins[0]),
      runStart = this.samplenum;
    while (true) {
      pins = yield this.wait({ data: 'e' });
      const next = Number(pins[0]),
        now = this.samplenum,
        duration = Number(now - runStart);
      if (level === 1) {
        this.lastHigh = duration;
        this.lastHighStart = runStart;
      } else if (this.lastHighStart !== null) {
        this.consumePair(this.lastHigh, duration, this.lastHighStart, now);
        this.lastHighStart = null;
      }
      level = next;
      runStart = now;
    }
  }

  onEof(): void {
    if (this.active && this.values.length) this.warning('Incomplete RF packet discarded at end of capture');
  }
}

export const rf433Plugin: DecoderPlugin<any, any> = {
  decoder: RF433Decoder,
  descriptor,
  createEngine: (context) => generatorPlugin(RF433Decoder).createEngine(context),
};

export default RF433Decoder;
