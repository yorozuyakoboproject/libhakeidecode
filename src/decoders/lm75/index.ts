import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { I2CDirection, I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

const RESOLUTION: Readonly<Record<number, number>> = { 0: 9, 1: 10, 2: 11, 3: 12 };
const FAULT_TOLERANCE: Readonly<Record<number, number>> = { 0: 1, 1: 2, 2: 4, 3: 6 };

export interface Lm75Options {
  sensor: string;
  resolution: number;
}

export const LM75_ANN = Object.freeze({
  CELSIUS: 0,
  KELVIN: 1,
  TEXT_VERBOSE: 2,
  TEXT: 3,
  WARNING: 4,
});

export class Lm75Decoder extends Decoder<Lm75Options> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state = 'IDLE';
  private reg = 0;
  private dataBytes: number[] = [];
  private ssBlock = 0n;
  private esBlock = 0n;

  constructor(options: Partial<Lm75Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'IDLE';
    this.reg = 0;
    this.dataBytes = [];
    this.ssBlock = 0n;
    this.esBlock = 0n;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putPacket(classIndex: number, text: string, ss: bigint, es: bigint): void {
    this.put(ss, es, this.outAnn, [classIndex, [text]]);
  }

  private putBlock(classIndex: number, text: string): void {
    this.put(this.ssBlock, this.esBlock, this.outAnn, [classIndex, [text]]);
  }

  private warnInvalidSlave(address: number, ss: bigint, es: bigint): void {
    if (address >= 0x48 && address <= 0x4f) return;
    this.putPacket(
      LM75_ANN.WARNING,
      'Warning: I²C slave 0x' + address.toString(16).padStart(2, '0') + ' not an LM75 compatible sensor.',
      ss,
      es,
    );
  }

  private outputTemperature(name: string, direction: I2CDirection): void {
    const before = this.dataBytes[0] ?? 0,
      after = ((this.dataBytes[1] ?? 0) >> 7) * 5,
      celsius = Number(`${before}.${after}`),
      kelvin = celsius + 273.15;
    this.putBlock(LM75_ANN.CELSIUS, name + ': ' + celsius.toFixed(1) + ' °C');
    this.putBlock(LM75_ANN.KELVIN, name + ': ' + kelvin.toFixed(1) + ' K');
    if (name === 'Temperature' && direction === 'write')
      this.putBlock(LM75_ANN.WARNING, 'Warning: The temperature register is read-only!');
  }

  private handleTemperature(value: number, name: string, direction: I2CDirection, ss: bigint, es: bigint): void {
    if (!this.dataBytes.length) {
      this.ssBlock = ss;
      this.dataBytes.push(value);
      return;
    }
    this.dataBytes.push(value);
    this.esBlock = es;
    this.outputTemperature(name, direction);
    this.dataBytes = [];
  }

  private handleConfiguration(value: number, ss: bigint, es: bigint): void {
    const shutdown = value & 1,
      comparator = value & 2,
      polarity = value & 4,
      faultBits = (value & 0x18) >> 3,
      faultText = shutdown === 0 ? 'normal operation' : 'shutdown mode',
      modeText = comparator === 0 ? 'comparator' : 'interrupt',
      polarityText = polarity === 0 ? 'low' : 'high';
    let verbose = 'SD = ' + shutdown + ': ' + faultText + '\n';
    let short = 'SD = ' + faultText + ', ';
    verbose += 'CMP/INT = ' + comparator + ': ' + modeText + ' mode\n';
    short += 'CMP/INT = ' + modeText + ', ';
    verbose += 'POL = ' + polarity + ': OS polarity is active-' + polarityText + '\n';
    short += 'POL = active-' + polarityText + ', ';
    verbose += 'Fault tolerance setting: ' + FAULT_TOLERANCE[faultBits] + ' bit(s)\n';
    short += 'FT = ' + FAULT_TOLERANCE[faultBits];
    if (this.options.sensor !== 'lm75') {
      const resolution = RESOLUTION[(value & 0x60) >> 5] ?? 9;
      verbose += 'Resolution: ' + resolution + ' bits\n';
      short += ', resolution = ' + resolution;
    }
    this.putPacket(LM75_ANN.TEXT_VERBOSE, verbose, ss, es);
    this.putPacket(LM75_ANN.TEXT, short, ss, es);
  }

  private handleData(value: number, direction: I2CDirection, ss: bigint, es: bigint): void {
    if (this.reg === 0) this.handleTemperature(value, 'Temperature', direction, ss, es);
    else if (this.reg === 1) this.handleConfiguration(value, ss, es);
    else if (this.reg === 2) this.handleTemperature(value, 'T_HYST trip temperature', direction, ss, es);
    else if (this.reg === 3) this.handleTemperature(value, 'T_OS trip temperature', direction, ss, es);
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    if (!Array.isArray(packet)) return;
    if (this.state === 'IDLE') {
      if (packet[0] !== 'START' || packet[1]) return;
      this.state = 'GET SLAVE ADDR';
      return;
    }
    if (this.state === 'GET SLAVE ADDR') {
      if (packet[0] !== 'ADDRESS') return;
      this.warnInvalidSlave(packet[2] >>> 1, ss, es);
      this.state = packet[1] === 'read' ? 'READ REGS' : 'WRITE REGS';
      return;
    }
    if (this.state === 'READ REGS' || this.state === 'WRITE REGS') {
      if (packet[0] === 'DATA') this.handleData(packet[2], packet[1], ss, es);
      else if (packet[0] === 'STOP') this.state = 'IDLE';
    }
  }
}

export default Lm75Decoder;
