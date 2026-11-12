import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

const SLAVE_ADDRESS_NAMES: Readonly<Record<number, readonly [string, string, string, string]>> = {
  0x00: ['GND', 'GND', 'GND', 'G'],
  0x01: ['FLOAT', 'FLOAT', 'FLOAT', 'F'],
  0x02: ['VCC', 'VCC', 'VCC', 'V'],
};

const COMMANDS: Readonly<Record<number, readonly string[]>> = {
  0x00: ['Write Input Register', 'Write In Reg', 'Wr In Reg', 'WIR'],
  0x01: ['Update DAC', 'Update', 'U'],
  0x03: ['Write and Power Up DAC', 'Write & Power Up', 'W&PU'],
  0x04: ['Power Down DAC', 'Power Down', 'PD'],
  0x0f: ['No Operation', 'No Op', 'NO'],
};

const ADDRESSES: Readonly<Record<number, readonly [string, string]>> = {
  0x00: ['DAC A', 'A'],
  0x01: ['DAC B', 'B'],
  0x0f: ['All DACs', 'All'],
};

const INVALID_ADDRESS_TEXTS = ['Invalid address', 'Invalid addr', 'Inv addr', 'INV'] as const;

function ternary(value: number): [number, number, number] | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > 26) return null;
  return [Math.floor(value / 9), Math.floor(value / 3) % 3, value % 3];
}

function slaveAddressPins(address: number): [number, number, number] | null {
  if (!Number.isInteger(address) || address < 0 || address > 0x7f || address & 0x0c) return null;
  const encoded = (address & 0x03) | ((address & 0x70) >> 2);
  if (encoded < 0x04 || encoded > 0x1e) return null;
  return ternary(encoded - 0x04);
}

export interface Ltc26x7Options {
  chip: 'ltc2607' | 'ltc2617' | 'ltc2627';
  vref: number;
}

export const LTC26X7_ANN = Object.freeze({
  SLAVE_ADDRESS: 0,
  COMMAND: 1,
  ADDRESS: 2,
  DAC_A_VOLTAGE: 3,
  DAC_B_VOLTAGE: 4,
});

export class Ltc26x7Decoder extends Decoder<Ltc26x7Options> {
  static descriptor = descriptor;
  private outAnn = -1;
  private state = 'IDLE';
  private ss: bigint | null = null;
  private raw = 0;
  private dacValue = 0;

  constructor(options: Partial<Ltc26x7Options> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = 'IDLE';
    this.ss = null;
    this.raw = 0;
    this.dacValue = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private handleSlaveAddress(address: number, ss: bigint, es: bigint): void {
    if (address === 0x73) {
      this.put(ss, es, this.outAnn, [LTC26X7_ANN.SLAVE_ADDRESS, ['Global address', 'Global addr', 'Glob addr', 'GA']]);
      return;
    }
    const pins = slaveAddressPins(address);
    if (!pins) {
      this.put(ss, es, this.outAnn, [LTC26X7_ANN.SLAVE_ADDRESS, INVALID_ADDRESS_TEXTS]);
      return;
    }
    const texts = [
      `CA2=${SLAVE_ADDRESS_NAMES[pins[0]]![0]} CA1=${SLAVE_ADDRESS_NAMES[pins[1]]![0]} CA0=${SLAVE_ADDRESS_NAMES[pins[2]]![0]}`,
      `2=${SLAVE_ADDRESS_NAMES[pins[0]]![1]} 1=${SLAVE_ADDRESS_NAMES[pins[1]]![1]} 0=${SLAVE_ADDRESS_NAMES[pins[2]]![1]}`,
      `${SLAVE_ADDRESS_NAMES[pins[0]]![2]} ${SLAVE_ADDRESS_NAMES[pins[1]]![2]} ${SLAVE_ADDRESS_NAMES[pins[2]]![2]}`,
      `${SLAVE_ADDRESS_NAMES[pins[0]]![3]} ${SLAVE_ADDRESS_NAMES[pins[1]]![3]} ${SLAVE_ADDRESS_NAMES[pins[2]]![3]}`,
    ];
    this.put(ss, es, this.outAnn, [LTC26X7_ANN.SLAVE_ADDRESS, texts]);
  }

  private handleCommand(value: number, ss: bigint, es: bigint): void {
    const command = COMMANDS[(value >> 4) & 0xf] ?? [`Command 0x${((value >> 4) & 0xf).toString(16)}`, 'Cmd'],
      address = ADDRESSES[value & 0xf] ?? [`Address 0x${(value & 0xf).toString(16)}`, 'Addr'],
      middle = (ss + es) / 2n;
    this.dacValue = value & 0xf;
    this.put(ss, middle, this.outAnn, [LTC26X7_ANN.COMMAND, command]);
    this.put(middle, es, this.outAnn, [LTC26X7_ANN.ADDRESS, address]);
  }

  private handleData(value: number, ss: bigint, es: bigint): void {
    let raw = ((this.raw << 8) & 0xff00) + value;
    let voltage: number;
    if (this.options.chip === 'ltc2617') {
      raw >>= 2;
      voltage = (this.options.vref * raw) / 0x3fff;
    } else if (this.options.chip === 'ltc2627') {
      raw >>= 4;
      voltage = (this.options.vref * raw) / 0x0fff;
    } else voltage = (this.options.vref * raw) / 0xffff;
    const texts = [voltage.toFixed(6) + 'V', voltage.toFixed(2) + 'V'];
    this.raw = 0;
    if (this.dacValue === 0x0f) {
      this.put(ss, es, this.outAnn, [LTC26X7_ANN.DAC_A_VOLTAGE, texts]);
      this.put(ss, es, this.outAnn, [LTC26X7_ANN.DAC_B_VOLTAGE, texts]);
    } else if (this.dacValue === 0x00 || this.dacValue === 0x01) {
      this.put(ss, es, this.outAnn, [LTC26X7_ANN.DAC_A_VOLTAGE + this.dacValue, texts]);
    }
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
      if (packet[0] !== 'ADDRESS' || packet[1] !== 'write') return;
      this.ss = ss;
      this.handleSlaveAddress(packet[2] >>> 1, ss, es);
      this.ss = null;
      this.state = 'GET CMD ADDR';
      return;
    }
    if (this.state === 'GET CMD ADDR') {
      if (packet[0] !== 'DATA' || packet[1] !== 'write') return;
      this.ss = ss;
      this.handleCommand(packet[2], ss, es);
      this.ss = null;
      this.state = 'WRITE DATA';
      return;
    }
    if (this.state !== 'WRITE DATA') return;
    if (packet[0] === 'DATA' && packet[1] === 'write') {
      if (this.ss === null) {
        this.ss = ss;
        this.raw = packet[2];
        return;
      }
      this.handleData(packet[2], this.ss, es);
      this.ss = null;
    } else if (packet[0] === 'STOP') this.state = 'IDLE';
  }
}

export default Ltc26x7Decoder;
