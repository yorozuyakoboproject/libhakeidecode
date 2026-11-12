import { Decoder, OUTPUT_ANN, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

export const QI_ANN = Object.freeze({
  BIT: 0,
  ERROR: 1,
  START: 2,
  INFO: 3,
  DATA: 4,
  PACKET: 5,
  CHECKSUM: 6,
});

const END_CODES = [
  'Unknown',
  'Charge Complete',
  'Internal Fault',
  'Over Temperature',
  'Over Voltage',
  'Over Current',
  'Battery Failure',
  'Reconfigure',
  'No Response',
] as const;

const PROPRIETARY = new Set([0x18, 0x19, 0x28, 0x29, 0x38, 0x48, 0x58, 0x68, 0x78, 0x85, 0xa4, 0xc4, 0xe2]);

function bitsToUint(bits: readonly number[]): number {
  let value = 0;
  for (let index = 0; index < bits.length; index++) value |= bits[index]! << index;
  return value;
}

function checksum(packet: readonly number[]): number {
  let value = 0;
  for (let index = 0; index < packet.length - 1; index++) value ^= packet[index]!;
  return value;
}

function packetLength(byte: number): number {
  if (byte <= 0x1f) return 1 + Math.floor(byte / 32);
  if (byte <= 0x7f) return 2 + Math.floor((byte - 0x20) / 16);
  if (byte <= 0xdf) return 8 + Math.floor((byte - 0x80) / 8);
  return 20 + Math.floor((byte - 0xe0) / 4);
}

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export class QiDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private bitWidth = 0;
  private outAnn = -1;
  private state: 'IDLE' | 'DATA' = 'IDLE';
  private lastBit = 0n;
  private byteStart = 0n;
  private durations: number[] = [];
  private bits: number[] = [];
  private bitSamples: bigint[] = [];
  private byteSamples: bigint[] = [];
  private packet: number[] = [];

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.bitWidth = 0;
    this.resetVariables();
  }

  private resetVariables(): void {
    this.state = 'IDLE';
    this.lastBit = 0n;
    this.byteStart = 0n;
    this.durations = [];
    this.bits = [];
    this.bitSamples = [];
    this.byteSamples = [];
    this.packet = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.resetVariables();
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) {
      this.samplerate = value;
      this.bitWidth = value / 2_000;
    }
  }

  private inTolerance(length: number): boolean {
    return length > 0.75 * this.bitWidth && length < 1.25 * this.bitWidth;
  }

  private putPacket(texts: readonly string[]): void {
    if (!this.byteSamples.length) return;
    this.put(this.byteSamples[0]!, this.byteSamples.at(-1)!, this.outAnn, [QI_ANN.PACKET, texts]);
  }

  private processPacket(): void {
    const packet = this.packet;
    const type = packet[0] ?? 0;
    if (type === 0x01) {
      this.putPacket([`Signal Strength: ${packet[1]}`, `SS: ${packet[1]}`, 'SS']);
    } else if (type === 0x02) {
      const reason = END_CODES[packet[1] ?? 0] ?? 'Reserved';
      this.putPacket([`End Power Transfer: ${reason}`, `EPT: ${reason}`, 'EPT']);
    } else if (type === 0x03) {
      const raw = packet[1] ?? 0;
      const value = raw < 128 ? raw : (raw & 0x7f) - 128;
      this.putPacket([`Control Error: ${value}`, `CE: ${value}`, 'CE']);
    } else if (type === 0x04) {
      this.putPacket([`Received Power: ${packet[1]}`, `RP: ${packet[1]}`, 'RP']);
    } else if (type === 0x05) {
      this.putPacket([`Charge Status: ${packet[1]}`, `CS: ${packet[1]}`, 'CS']);
    } else if (type === 0x06) {
      this.putPacket([`Power Control Hold-off: ${packet[1]}ms`, `PCH: ${packet[1]}`, 'PCH']);
    } else if (type === 0x51) {
      const powerClass = ((packet[1] ?? 0) & 0xc0) >> 7;
      const maxPower = (packet[1] ?? 0) & 0x3f;
      const prop = ((packet[3] ?? 0) & 0x80) >> 7;
      const count = (packet[3] ?? 0) & 0x07;
      const windowSize = ((packet[4] ?? 0) & 0xf8) >> 3;
      const windowOffset = (packet[4] ?? 0) & 0x07;
      this.putPacket([
        `Configuration: Power Class = ${powerClass}, Maximum Power = ${maxPower}, Prop = ${prop}, Count = ${count}, Window Size = ${windowSize}, Window Offset = ${windowOffset}`,
        `C: PC = ${powerClass} MP = ${maxPower} P = ${prop} C = ${count} WS = ${windowSize} WO = ${windowOffset}`,
        'Configuration',
        'C',
      ]);
    } else if (type === 0x71) {
      const version = `${((packet[1] ?? 0) & 0xf0) >> 4}.${(packet[1] ?? 0) & 0x0f}`;
      const manufacturer = `${hex(packet[2] ?? 0)}${hex(packet[3] ?? 0)}`;
      const device = [(packet[4] ?? 0) & ~0x80 & 0xff, packet[5] ?? 0, packet[6] ?? 0, packet[7] ?? 0]
        .map(hex)
        .join('');
      this.putPacket([
        `Identification: Version = ${version}, Manufacturer = ${manufacturer}, Device = ${device}`,
        `ID: ${version} ${manufacturer} ${device}`,
        'ID',
      ]);
    } else if (type === 0x81) {
      const device = packet.slice(1, -1).map(hex).join('');
      this.putPacket([`Extended Identification: ${device}`, `EI: ${device}`, 'EI']);
    } else if (PROPRIETARY.has(type)) {
      this.putPacket(['Proprietary', 'P']);
    } else {
      this.putPacket(['Unknown', '?']);
    }
    const texts = checksum(packet) === packet.at(-1) ? ['Checksum OK', 'OK'] : ['Checksum error', 'ERR'];
    this.put(this.byteSamples.at(-1)!, this.samplenum, this.outAnn, [QI_ANN.CHECKSUM, texts]);
  }

  private processByte(): void {
    if (this.bits.length < 11 || this.bitSamples.length < 11) return;
    const dataBits = this.bits.slice(1, 9);
    const data = bitsToUint(dataBits);
    const parity = dataBits.reduce((value, bit) => (value + bit) % 2, 1);
    this.put(this.byteStart, this.bitSamples[0]!, this.outAnn, [
      this.bits[0] === 0 ? QI_ANN.START : QI_ANN.ERROR,
      this.bits[0] === 0 ? ['Start bit', 'Start', 'S'] : ['Start error', 'Start err', 'SE'],
    ]);
    this.put(this.bitSamples[0]!, this.bitSamples[8]!, this.outAnn, [QI_ANN.DATA, [hex(data)]]);
    this.put(this.bitSamples[8]!, this.bitSamples[9]!, this.outAnn, [
      this.bits[9] === parity ? QI_ANN.INFO : QI_ANN.ERROR,
      this.bits[9] === parity ? ['Parity bit', 'Parity', 'P'] : ['Parity error', 'Parity err', 'PE'],
    ]);
    this.put(this.bitSamples[9]!, this.bitSamples[10]!, this.outAnn, [
      this.bits[10] === 1 ? QI_ANN.INFO : QI_ANN.ERROR,
      this.bits[10] === 1 ? ['Stop bit', 'Stop', 'S'] : ['Stop error', 'Stop err', 'SE'],
    ]);

    this.byteSamples.push(this.byteStart);
    this.packet.push(data);
    if (packetLength(this.packet[0] ?? 0) + 2 === this.packet.length) {
      this.processPacket();
      this.byteSamples = [];
      this.packet = [];
    }
  }

  private addBit(bit: number): void {
    this.bits.push(bit);
    this.bitSamples.push(this.samplenum);
    const tail = this.bits.slice(-5);
    if (
      this.state === 'IDLE' &&
      tail.length === 5 &&
      tail[0] === 1 &&
      tail[1] === 1 &&
      tail[2] === 1 &&
      tail[3] === 1 &&
      tail[4] === 0
    ) {
      this.state = 'DATA';
      this.byteStart = this.bitSamples.at(-2)!;
      this.bits = [0];
      this.bitSamples = [this.samplenum];
      this.packet = [];
    } else if (this.state === 'DATA' && this.bits.length === 11) {
      this.processByte();
      this.byteStart = this.samplenum;
      this.bits = [];
      this.bitSamples = [];
    }
    if (this.state !== 'IDLE') this.put(this.lastBit, this.samplenum, this.outAnn, [QI_ANN.BIT, [String(bit)]]);
    this.lastBit = this.samplenum;
  }

  private resetPacket(): void {
    this.state = 'IDLE';
    this.byteSamples = [];
    this.packet = [];
    this.bits = [];
    this.bitSamples = [];
  }

  private handleTransition(length: number, highToLow: boolean): void {
    this.durations.push(length);
    if (this.durations.length > 2) this.durations.shift();
    const [older, newer] = this.durations;
    if (
      this.durations.length >= 2 &&
      (this.inTolerance(newer! + older!) ||
        (highToLow && this.inTolerance(length * 2) && older! > 1.25 * this.bitWidth))
    ) {
      this.addBit(1);
      this.durations = [];
    } else if (this.inTolerance(length)) {
      this.addBit(0);
      this.durations = [];
    } else if (length > 1.25 * this.bitWidth) {
      this.resetPacket();
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    if (!(this.bitWidth > 0)) throw new Error('Invalid Qi bit width.');
    const first = yield this.wait();
    this.handleTransition(Number(this.samplenum), Number(first[0]) === 0);
    while (true) {
      const previous = this.samplenum;
      const pins = yield this.wait({ qi: 'e' });
      this.handleTransition(Number(this.samplenum - previous), Number(pins[0]) === 0);
    }
  }
}

export default QiDecoder;
