import { Decoder, OUTPUT_ANN, OUTPUT_BINARY } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { I2CProtocolPacket } from '../i2c/index.js';
import { descriptor } from './descriptor.js';

interface Chip {
  readonly pageSize: number;
  readonly addressBytes: 1 | 2;
  readonly addressPins: number;
}

const CHIPS: Readonly<Record<string, Chip>> = {
  generic: { pageSize: 8, addressBytes: 1, addressPins: 3 },
  microchip_24aa65: { pageSize: 64, addressBytes: 2, addressPins: 3 },
  microchip_24lc65: { pageSize: 64, addressBytes: 2, addressPins: 3 },
  microchip_24c65: { pageSize: 64, addressBytes: 2, addressPins: 3 },
  microchip_24aa64: { pageSize: 32, addressBytes: 2, addressPins: 3 },
  microchip_24lc64: { pageSize: 32, addressBytes: 2, addressPins: 3 },
  microchip_24aa02uid: { pageSize: 8, addressBytes: 1, addressPins: 0 },
  microchip_24aa025uid: { pageSize: 16, addressBytes: 1, addressPins: 3 },
  microchip_24aa025uid_sot23: { pageSize: 16, addressBytes: 1, addressPins: 2 },
  onsemi_cat24c256: { pageSize: 64, addressBytes: 2, addressPins: 3 },
  onsemi_cat24m01: { pageSize: 256, addressBytes: 2, addressPins: 2 },
  siemens_slx_24c01: { pageSize: 8, addressBytes: 1, addressPins: 0 },
  siemens_slx_24c02: { pageSize: 8, addressBytes: 1, addressPins: 0 },
  st_m24c01: { pageSize: 16, addressBytes: 1, addressPins: 3 },
  st_m24c02: { pageSize: 16, addressBytes: 1, addressPins: 3 },
  st_m24c32: { pageSize: 32, addressBytes: 2, addressPins: 3 },
  xicor_x24c02: { pageSize: 4, addressBytes: 1, addressPins: 3 },
};

interface BitSpan {
  value: number;
  ss: bigint;
  es: bigint;
}

interface Packet {
  ss: bigint;
  es: bigint;
  dataEs: bigint;
  value: number;
  ack: boolean;
  bits: BitSpan[];
}

type State =
  | 'WAIT'
  | 'GET_CONTROL'
  | 'W_WORD_ADDR'
  | 'W_DETERMINE'
  | 'W_BYTE'
  | 'R_CURRENT'
  | 'R_CURRENT_FINAL'
  | 'R2_CONTROL'
  | 'R2_BYTE'
  | 'R_FINAL';

interface EepromOptions {
  chip: string;
  addr_counter: number;
}

function bitsOf(value: number, ss: bigint, es: bigint): BitSpan[] {
  const span = es - ss;
  return Array.from({ length: 8 }, (_, index) => {
    const position = 7 - index;
    return {
      value: (value >>> index) & 1,
      ss: ss + (span * BigInt(position)) / 8n,
      es: ss + (span * BigInt(position + 1)) / 8n,
    };
  });
}

function dataEnd(_ss: bigint, es: bigint): bigint {
  return es;
}

function sevenBitAddress(address: number): number {
  return address > 0x7f ? address >>> 1 : address;
}

function hex(value: number, digits = 2): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

export class Eeprom24xxDecoder extends Decoder<EepromOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private outBinary = -1;
  private chip: Chip = CHIPS.generic!;
  private addressCounter = 0;
  private state: State = 'WAIT';
  private packets: Packet[] = [];
  private bytebuf: number[] = [];
  private blockStart = 0n;

  constructor(options: Partial<EepromOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.resetVariables();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.chip = CHIPS[this.options.chip] ?? CHIPS.generic!;
    this.addressCounter = Number.isFinite(this.options.addr_counter) ? this.options.addr_counter : 0;
  }

  private resetVariables(): void {
    this.state = 'WAIT';
    this.packets = [];
    this.bytebuf = [];
  }

  private annotate(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warn(message: string, ss: bigint, es: bigint): void {
    this.annotate(ss, es, 0, [`Warning: ${message}`]);
  }

  private putBits(
    first: number,
    last: number,
    bits: readonly BitSpan[],
    classIndex: number,
    texts: readonly string[],
  ): void {
    this.annotate(bits[first]!.ss, bits[last]!.es, classIndex, texts);
  }

  private putControlWord(packet: Packet): void {
    const bits = packet.bits,
      code = bits
        .slice(4)
        .reverse()
        .map((bit) => bit.value)
        .join('');
    this.putBits(7, 4, bits, 1, [
      `Control code bits: ${code}`,
      `Control code: ${code}`,
      `Ctrl code: ${code}`,
      'Ctrl code',
      'Ctrl',
      'C',
    ]);
    for (let index = this.chip.addressPins - 1; index >= 0; index--) {
      const value = bits[index + 1]!.value;
      this.putBits(index + 1, index + 1, bits, 2, [
        `Address bit ${index}: ${value}`,
        `Addr bit ${index}`,
        `A${index}`,
        'A',
      ]);
    }
    const read = bits[0]!.value === 1,
      action = read ? 'read' : 'write';
    this.putBits(0, 0, bits, 3, [`R/W bit: ${action}`, 'R/W', 'RW', read ? 'R' : 'W']);
    this.putBits(7, 0, bits, 6, ['Control word', 'Control', 'CW', 'C']);
  }

  private putWordAddress(): void {
    if (this.chip.addressBytes === 1) {
      const packet = this.packets[1]!;
      this.annotate(packet.ss, packet.dataEs, 4, [
        `Word address byte: ${hex(packet.value)}`,
        `Word addr byte: ${hex(packet.value)}`,
        `Addr: ${hex(packet.value)}`,
        `A: ${hex(packet.value)}`,
        hex(packet.value),
      ]);
      this.annotate(packet.ss, packet.dataEs, 7, ['Word address', 'Word addr', 'Addr', 'A']);
      this.addressCounter = packet.value;
    } else {
      const high = this.packets[1]!,
        low = this.packets[2]!;
      this.annotate(high.ss, high.dataEs, 4, [
        `Word address high byte: ${hex(high.value)}`,
        `Word addr high byte: ${hex(high.value)}`,
        `Addr high: ${hex(high.value)}`,
        `AH: ${hex(high.value)}`,
        hex(high.value),
      ]);
      this.annotate(low.ss, low.dataEs, 4, [
        `Word address low byte: ${hex(low.value)}`,
        `Word addr low byte: ${hex(low.value)}`,
        `Addr low: ${hex(low.value)}`,
        `AL: ${hex(low.value)}`,
        hex(low.value),
      ]);
      this.annotate(high.ss, low.dataEs, 7, ['Word address', 'Word addr', 'Addr', 'A']);
      this.addressCounter = (high.value << 8) | low.value;
    }
  }

  private putDataByte(packet: Packet): void {
    const address = this.addressCounter
        .toString(16)
        .toUpperCase()
        .padStart(this.chip.addressBytes * 2, '0'),
      value = hex(packet.value);
    this.annotate(packet.ss, packet.dataEs, 5, [
      `Data byte ${address}: ${value}`,
      `Data byte: ${value}`,
      `Byte: ${value}`,
      `DB: ${value}`,
      value,
    ]);
    this.addressCounter++;
  }

  private putDataField(start: Packet, end: Packet): void {
    this.annotate(start.ss, end.dataEs, 8, ['Data', 'D']);
  }

  private hexBytes(from: number): string {
    return this.bytebuf
      .slice(from)
      .map((value) => hex(value))
      .join(' ');
  }

  private addressAndLength(): string {
    const address =
      this.chip.addressBytes === 1
        ? hex(this.bytebuf[0] ?? 0)
        : `${hex(this.bytebuf[0] ?? 0)}${hex(this.bytebuf[1] ?? 0)}`;
    let count = this.bytebuf.length - this.chip.addressBytes;
    if (count < 0) count = 0;
    return `addr=${address}, ${count} ${count <= 1 ? 'byte' : 'bytes'}`;
  }

  private emitBinary(bytes: readonly number[], es: bigint): void {
    if (!bytes.length) return;
    this.put(this.blockStart, es, this.outBinary, [0, Uint8Array.from(bytes)]);
  }

  private putDataBytes(startIndex: number, classIndex: number, label: string, es: bigint): boolean {
    const packets = this.packets.slice(startIndex);
    if (!packets.length) return false;
    for (const packet of packets) this.putDataByte(packet);
    this.putDataField(packets[0]!, packets.at(-1)!);
    const address = this.addressAndLength(),
      initials = label
        .split(/\s+/)
        .map((word) => word[0] ?? '')
        .join('')
        .toUpperCase(),
      data = this.hexBytes(this.chip.addressBytes);
    this.annotate(this.blockStart, es, classIndex, [
      `${label} (${address}): ${data}`,
      `${label} (${address})`,
      label,
      initials,
      label[0]!,
    ]);
    this.emitBinary(this.bytebuf.slice(this.chip.addressBytes), es);
    return true;
  }

  private finishWrite(es: bigint, repeated: boolean): void {
    if (this.bytebuf.length < this.chip.addressBytes + 1) {
      this.resetVariables();
      return;
    }
    this.putWordAddress();
    const initialAddress = this.addressCounter,
      dataBytes = this.bytebuf.length - this.chip.addressBytes,
      start = 1 + this.chip.addressBytes;
    if (dataBytes === 1) {
      this.putDataBytes(start, 9, 'Byte write', es);
    } else {
      this.putDataBytes(start, 10, 'Page write', es);
      if (dataBytes > this.chip.pageSize)
        this.warn(`Wrote ${dataBytes} bytes but page size is only ${this.chip.pageSize} bytes!`, this.blockStart, es);
      const firstPage = Math.trunc(initialAddress / this.chip.pageSize),
        lastPage = Math.trunc((this.addressCounter - 1) / this.chip.pageSize);
      if (firstPage !== lastPage)
        this.warn(`Page write crossed page boundary from page ${firstPage} to ${lastPage}!`, this.blockStart, es);
    }
    this.resetVariables();
    if (repeated) this.state = 'GET_CONTROL';
  }

  private finishCurrent(es: bigint, repeated: boolean): void {
    const dataPackets = this.packets.slice(1);
    if (!dataPackets.length) {
      this.resetVariables();
      return;
    }
    const initialAddress = this.addressCounter;
    for (const packet of dataPackets) this.putDataByte(packet);
    this.putDataField(dataPackets[0]!, dataPackets.at(-1)!);
    const data = this.hexBytes(0);
    if (dataPackets.length === 1) {
      this.annotate(this.blockStart, es, 11, [
        `Current address read: ${hex(dataPackets[0]!.value)}`,
        'Current address read',
        'Cur addr read',
        'CAR',
        'C',
      ]);
    } else {
      this.annotate(this.blockStart, es, 14, [
        `Sequential current address read at ${hex(initialAddress, this.chip.addressBytes * 2)}: ${data}`,
        'Sequential current address read',
        'Seq cur addr read',
        'SCAR',
        'S',
      ]);
    }
    this.emitBinary(this.bytebuf, es);
    this.resetVariables();
    if (repeated) this.state = 'GET_CONTROL';
  }

  private finishRandom(es: bigint, repeated: boolean): void {
    if (this.bytebuf.length < this.chip.addressBytes + 1) {
      this.resetVariables();
      return;
    }
    const readControl = this.packets[1 + this.chip.addressBytes];
    if (!readControl) {
      this.resetVariables();
      return;
    }
    this.putControlWord(readControl);
    this.putWordAddress();
    const dataBytes = this.bytebuf.length - this.chip.addressBytes,
      start = 2 + this.chip.addressBytes;
    this.putDataBytes(
      start,
      dataBytes === 1 ? 12 : 13,
      dataBytes === 1 ? 'Random access read' : 'Sequential random read',
      es,
    );
    this.resetVariables();
    if (repeated) this.state = 'GET_CONTROL';
  }

  private handleStart(ss: bigint, repeated: boolean): void {
    if (repeated && (this.state === 'W_DETERMINE' || this.state === 'W_BYTE')) {
      this.state = 'R2_CONTROL';
      return;
    }
    if (repeated && (this.state === 'R_CURRENT_FINAL' || this.state === 'R_FINAL')) {
      const current = this.state === 'R_CURRENT_FINAL';
      this.warn('STOP expected (not RESTART)', this.blockStart, ss);
      if (current) this.finishCurrent(ss, false);
      else this.finishRandom(ss, false);
      this.blockStart = ss;
      this.state = 'GET_CONTROL';
      return;
    }
    this.resetVariables();
    this.blockStart = ss;
    this.state = 'GET_CONTROL';
  }

  private handleAddress(ss: bigint, es: bigint, direction: 'read' | 'write', address: number, ack: boolean): void {
    if (this.state !== 'GET_CONTROL' && this.state !== 'R2_CONTROL') return;
    const control = ((sevenBitAddress(address) & 0x7f) << 1) | (direction === 'read' ? 1 : 0),
      packet: Packet = { ss, es, dataEs: dataEnd(ss, es), value: control, ack, bits: bitsOf(control, ss, es) };
    if (this.state === 'GET_CONTROL') {
      this.packets.push(packet);
      this.putControlWord(packet);
      if (!ack) {
        this.warn('No reply from slave!', this.blockStart, es);
        this.resetVariables();
        return;
      }
      this.state = direction === 'read' ? 'R_CURRENT' : 'W_WORD_ADDR';
      return;
    }
    if (direction !== 'read') {
      this.resetVariables();
      return;
    }
    this.packets.push(packet);
    if (!ack) {
      this.resetVariables();
      return;
    }
    this.state = 'R2_BYTE';
  }

  private handleData(ss: bigint, es: bigint, direction: 'read' | 'write', value: number, ack: boolean): void {
    if (direction === 'write') {
      if (this.state !== 'W_WORD_ADDR' && this.state !== 'W_DETERMINE' && this.state !== 'W_BYTE') return;
      const packet: Packet = { ss, es, dataEs: dataEnd(ss, es), value, ack, bits: bitsOf(value, ss, es) };
      this.packets.push(packet);
      this.bytebuf.push(value);
      if (!ack) {
        this.resetVariables();
        return;
      }
      if (this.state === 'W_WORD_ADDR') this.state = 'W_DETERMINE';
      else this.state = 'W_BYTE';
      return;
    }
    if (this.state !== 'R_CURRENT' && this.state !== 'R2_BYTE') return;
    const packet: Packet = { ss, es, dataEs: dataEnd(ss, es), value, ack, bits: bitsOf(value, ss, es) };
    this.packets.push(packet);
    this.bytebuf.push(value);
    if (!ack) this.state = this.state === 'R_CURRENT' ? 'R_CURRENT_FINAL' : 'R_FINAL';
  }

  private handleStop(es: bigint): void {
    if (this.state === 'W_DETERMINE' || this.state === 'W_BYTE') this.finishWrite(es, false);
    else if (this.state === 'R_CURRENT') this.finishCurrent(es, false);
    else if (this.state === 'R_CURRENT_FINAL') this.finishCurrent(es, false);
    else if (this.state === 'R2_BYTE') {
      this.warn('STOP expected after a NACK (not ACK)', this.blockStart, es);
      this.finishRandom(es, false);
    } else if (this.state === 'R_FINAL') this.finishRandom(es, false);
    else this.resetVariables();
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as I2CProtocolPacket;
    if (packet[0] === 'START') this.handleStart(ss, packet[1]);
    else if (packet[0] === 'STOP') this.handleStop(es);
    else if (packet[0] === 'ADDRESS') this.handleAddress(ss, es, packet[1], packet[2], packet[3]);
    else if (packet[0] === 'DATA') this.handleData(ss, es, packet[1], packet[2], packet[3]);
  }
}

export default Eeprom24xxDecoder;
