import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { SPIProtocolPacket } from '../spi/index.js';
import { descriptor } from './descriptor.js';
import { FLASH_BY_CODE, FLASH_CHIPS, flashDeviceName } from './parts.js';
import type { FlashChip, FlashCommand } from './parts.js';

interface SpiflashOptions {
  chip: string;
  format: string;
}

const ANN = Object.freeze({ BIT: 28, FIELD: 29, WARNING: 30 });

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function statusRegisterText(value: number): string {
  const wip = (value & 1) !== 0 ? 'W' : 'No w',
    wel = (value & 2) !== 0 ? '' : 'not ',
    cp = (value & 0x40) !== 0 ? '' : 'not ',
    srwd = (value & 0x80) !== 0 ? 'not ' : '';
  return (
    `${wip}rite operation in progress.\n` +
    `Internal write enable latch is ${wel}set.\n` +
    `Block protection bits (BP3-BP0): 0x${((value & 0x3c) >>> 2).toString(16)}.\n` +
    `Device is ${cp}in continuously program mode (CP mode).\n` +
    `Status register writes are ${srwd}allowed.\n`
  );
}

function dualBytes(sio0: number, sio1: number): [number, number] {
  const combine = (even: number, odd: number): number => {
    let result = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (even & (1 << bit)) result |= 1 << (bit * 2);
      if (odd & (1 << bit)) result |= 1 << (bit * 2 + 1);
    }
    return result;
  };
  return [combine(sio0 >>> 4, sio1 >>> 4), combine(sio0 & 0x0f, sio1 & 0x0f)];
}

interface WordByte {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

interface WordPair {
  readonly mosi: WordByte;
  readonly miso: WordByte;
}

export class SpiflashDecoder extends Decoder<SpiflashOptions> {
  static descriptor = descriptor;

  private outAnn = -1;
  private chip: FlashChip = FLASH_CHIPS.adesto_at45db161e!;
  private vendor = 'adesto';
  private state: FlashCommand | null = null;
  private cmdstate = 1;
  private addr = 0;
  private data: number[] = [];
  private deviceId = -1;
  private writeState = false;
  private ssCmd = 0n;
  private esCmd = 0n;
  private ssField = 0n;
  private esField = 0n;
  private lastWordSs: bigint | null = null;
  private lastWordEs: bigint | null = null;
  private endAction: (() => void) | null = null;
  private manufacturerFirst = true;
  private ids: number[] = [];

  constructor(options: Partial<SpiflashOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.state = null;
    this.cmdstate = 1;
    this.addr = 0;
    this.data = [];
    this.deviceId = -1;
    this.writeState = false;
    this.lastWordSs = null;
    this.lastWordEs = null;
    this.endAction = null;
    this.manufacturerFirst = true;
    this.ids = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.chip = FLASH_CHIPS[this.options.chip] ?? FLASH_CHIPS.adesto_at45db161e!;
    this.vendor = this.options.chip.split('_')[0] ?? 'adesto';
    if (this.options.format !== 'hex' && this.options.format !== 'ascii')
      throw new Error('Data format must be hex or ascii.');
  }

  private putAt(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private warning(text: string): void {
    this.putAt(this.samplenum, this.samplenum, ANN.WARNING, [text]);
  }

  private deviceName(): string {
    return flashDeviceName(this.vendor, this.deviceId);
  }

  private vendorDevice(): string {
    return `${this.chip.vendor} ${this.deviceName()}`;
  }

  private commandTexts(command: FlashCommand): string[] {
    return [
      `Command: ${command.description} (${command.name})`,
      `Command: ${command.description}`,
      `Cmd: ${command.description}`,
      `Cmd: ${command.name}`,
      command.name,
    ];
  }

  private vendorDeviceTexts(command: FlashCommand): string[] {
    const device = `Device = ${this.vendorDevice()}`;
    return [
      `${command.description} (${command.name}): ${device}`,
      `${command.description}: ${device}`,
      `${command.name}: ${device}`,
      device,
      this.vendorDevice(),
    ];
  }

  private putCommand(command: FlashCommand, texts = this.commandTexts(command), es = this.esCmd): void {
    this.putAt(this.ssCmd, es, command.classIndex, texts);
  }

  private emitCommandByte(command: FlashCommand, byte: WordByte): void {
    this.ssCmd = byte.ss;
    this.esCmd = byte.es;
    this.data = [];
    this.addr = 0;
    this.putAt(byte.ss, byte.es, ANN.FIELD, this.commandTexts(command));
  }

  private emitAddressByte(byte: WordByte): void {
    this.addr = ((this.addr << 8) | byte.value) >>> 0;
    const highBit = (3 - (this.cmdstate - 2)) * 8;
    this.putAt(byte.ss, byte.es, ANN.BIT, [
      `Address bits ${highBit - 1}..${highBit - 8}: 0x${hex(byte.value, 2)}`,
      `Addr bits ${highBit - 1}..${highBit - 8}: 0x${hex(byte.value, 2)}`,
      `Addr bits ${highBit - 1}..${highBit - 8}`,
      `A${highBit - 1}..A${highBit - 8}`,
    ]);
    if (this.cmdstate === 2) this.ssField = byte.ss;
    this.esField = byte.es;
    if (this.cmdstate === 4)
      this.putAt(this.ssField, byte.es, ANN.FIELD, [
        `Address: 0x${hex(this.addr, 6)}`,
        `Addr: 0x${hex(this.addr, 6)}`,
        `0x${hex(this.addr, 6)}`,
      ]);
  }

  private startData(byte: WordByte): void {
    this.ssField = byte.ss;
    this.esField = byte.es;
    this.data = [];
  }

  private formatBytes(data: readonly number[]): string {
    return this.options.format === 'ascii'
      ? data.map((value) => String.fromCharCode(value)).join('')
      : data.map((value) => hex(value, 2)).join(' ');
  }

  private queueDataOutput(command: FlashCommand): void {
    this.endAction = () => {
      this.esField = this.esCmd;
      this.putAt(this.ssField, this.esField, ANN.FIELD, [`Data (${this.data.length} bytes)`]);
      this.putCommand(command, [
        `${command.description} (addr 0x${hex(this.addr, 6)}, ${this.data.length} bytes): ${this.formatBytes(this.data)}`,
      ]);
    };
  }

  private endTransaction(es: bigint): void {
    this.esCmd = es;
    const action = this.endAction;
    this.endAction = null;
    action?.();
    this.state = null;
    this.cmdstate = 1;
    this.addr = 0;
    this.data = [];
    this.ids = [];
  }

  private handleWriteLike(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      if (!this.writeState) this.putAt(pair.mosi.ss, pair.mosi.es, ANN.WARNING, ['Warning: WREN might be missing']);
    } else if (this.cmdstate <= 4) {
      this.emitAddressByte(pair.mosi);
    } else {
      if (this.cmdstate === 5) this.startData(pair.mosi);
      this.esField = pair.mosi.es;
      this.data.push(pair.mosi.value);
      if (this.cmdstate === 5) this.queueDataOutput(command);
    }
    this.cmdstate++;
  }

  private handleRead(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else if (this.cmdstate <= 4) this.emitAddressByte(pair.mosi);
    else {
      if (this.cmdstate === 5) this.startData(pair.miso);
      this.esField = pair.miso.es;
      this.data.push(pair.miso.value);
      if (this.cmdstate === 5) this.queueDataOutput(command);
    }
    this.cmdstate++;
  }

  private handleFastRead(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else if (this.cmdstate <= 4) this.emitAddressByte(pair.mosi);
    else if (this.cmdstate === 5)
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.BIT, [`Dummy byte: 0x${hex(pair.mosi.value, 2)}`]);
    else {
      if (this.cmdstate === 6) this.startData(pair.miso);
      this.esField = pair.miso.es;
      this.data.push(pair.miso.value);
      if (this.cmdstate === 6) this.queueDataOutput(command);
    }
    this.cmdstate++;
  }

  private handleReadStatus(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else {
      this.esCmd = pair.miso.es;
      this.putAt(pair.miso.ss, pair.miso.es, ANN.BIT, [statusRegisterText(pair.miso.value)]);
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [
        command.code === 0x35 ? 'Status register 2' : 'Status register',
      ]);
      this.putCommand(command, this.commandTexts(command), pair.miso.es);
      if (command.code === 0x05) this.writeState = (pair.miso.value & 2) !== 0;
    }
    this.cmdstate++;
  }

  private handleWriteStatus(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      this.endAction = () => this.putCommand(command);
    } else if (this.cmdstate <= 3) {
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.BIT, [statusRegisterText(pair.mosi.value)]);
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.FIELD, [
        this.cmdstate === 2 ? 'Status register 1' : 'Status register 2',
      ]);
      this.writeState = false;
    }
    this.cmdstate++;
  }

  private handleNoData(command: FlashCommand, pair: WordPair, action?: () => void): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      action?.();
      this.putCommand(command);
    }
    this.cmdstate++;
  }

  private handleSectorErase(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      if (!this.writeState) this.putAt(pair.mosi.ss, pair.mosi.es, ANN.WARNING, ['Warning: WREN might be missing']);
    } else if (this.cmdstate <= 4) {
      this.emitAddressByte(pair.mosi);
    }
    if (this.cmdstate === 4) {
      this.putCommand(command, [`Erase sector ${this.addr} (0x${hex(this.addr, 6)})`]);
      if (this.addr % 4096 !== 0) this.warning('Warning: Invalid sector address!');
    }
    this.cmdstate++;
  }

  private handleBlockErase(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      if (!this.writeState) this.putAt(pair.mosi.ss, pair.mosi.es, ANN.WARNING, ['Warning: WREN might be missing']);
    } else if (this.cmdstate <= 4) {
      this.emitAddressByte(pair.mosi);
    }
    if (this.cmdstate === 4) {
      this.putCommand(command, [`Erase block ${this.addr} (0x${hex(this.addr, 6)})`]);
      const blockSize = this.chip.blockSize;
      if (blockSize !== null && this.addr % blockSize !== 0) this.warning('Warning: Invalid block address!');
    }
    this.cmdstate++;
  }

  private handleReadId(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else if (this.cmdstate === 2)
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [`Manufacturer ID: 0x${hex(pair.miso.value, 2)}`]);
    else if (this.cmdstate === 3)
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [`Memory type: 0x${hex(pair.miso.value, 2)}`]);
    else if (this.cmdstate === 4) {
      this.deviceId = pair.miso.value;
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [`Device ID: 0x${hex(pair.miso.value, 2)}`]);
      this.esCmd = pair.miso.es;
      this.putCommand(command, this.vendorDeviceTexts(command));
      this.state = null;
    }
    if (this.state) this.cmdstate++;
  }

  private handleRems(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else if (this.cmdstate === 2 || this.cmdstate === 3)
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.FIELD, [`Dummy byte: 0x${hex(pair.mosi.value, 2)}`]);
    else if (this.cmdstate === 4) {
      this.manufacturerFirst = pair.mosi.value === 0;
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.FIELD, [
        `Master wants ${this.manufacturerFirst ? 'manufacturer' : 'device'} ID first`,
      ]);
    } else if (this.cmdstate === 5) {
      this.ids = [pair.miso.value];
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [
        `${this.manufacturerFirst ? 'Manufacturer' : 'Device'} ID: 0x${hex(pair.miso.value, 2)}`,
      ]);
    } else if (this.cmdstate === 6) {
      this.ids.push(pair.miso.value);
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [
        `${this.manufacturerFirst ? 'Device' : 'Manufacturer'} ID: 0x${hex(pair.miso.value, 2)}`,
      ]);
      this.deviceId = this.manufacturerFirst ? this.ids[1]! : this.ids[0]!;
      this.esCmd = pair.miso.es;
      this.putCommand(command, this.vendorDeviceTexts(command));
      this.state = null;
    }
    if (this.state) this.cmdstate++;
  }

  private handleRelease(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else if (this.cmdstate <= 4)
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.FIELD, [`Dummy byte: ${hex(pair.mosi.value, 2)}`]);
    else if (this.cmdstate === 5) {
      this.deviceId = pair.miso.value;
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [`Device ID: ${this.deviceName()}`]);
      this.esCmd = pair.miso.es;
      this.putCommand(command, this.vendorDeviceTexts(command));
      this.state = null;
    }
    if (this.state) this.cmdstate++;
  }

  private handleDualRead(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
    } else {
      const [first, second] = dualBytes(pair.mosi.value, pair.miso.value);
      const firstByte = { value: first, ss: pair.mosi.ss, es: pair.mosi.es },
        secondByte = { value: second, ss: pair.mosi.ss, es: pair.mosi.es };
      if (this.cmdstate === 2) {
        this.emitAddressByte(firstByte);
        this.cmdstate = 3;
        this.emitAddressByte(secondByte);
      } else if (this.cmdstate === 4) {
        this.emitAddressByte(firstByte);
        this.cmdstate = 5;
        this.putAt(pair.mosi.ss, pair.mosi.es, ANN.BIT, [`Dummy byte: 0x${hex(secondByte.value, 2)}`]);
      } else {
        if (this.cmdstate === 6) this.startData(pair.miso);
        this.esField = pair.miso.es;
        this.data.push(firstByte.value, secondByte.value);
        if (this.cmdstate === 6) this.queueDataOutput(command);
      }
    }
    this.cmdstate++;
  }

  private handleSecurityRead(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else {
      this.esCmd = pair.miso.es;
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [`Security register byte: 0x${hex(pair.miso.value, 2)}`]);
      this.putCommand(command, this.commandTexts(command), pair.miso.es);
    }
    this.cmdstate++;
  }

  private handleSecurityWrite(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      this.endAction = () => this.putCommand(command);
    } else if (this.cmdstate === 2) {
      this.putAt(pair.mosi.ss, pair.mosi.es, ANN.FIELD, [`Security register byte: 0x${hex(pair.mosi.value, 2)}`]);
    }
    this.cmdstate++;
  }

  private handleStatusRead(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) {
      this.emitCommandByte(command, pair.mosi);
      this.endAction = () => this.putCommand(command);
    } else {
      this.putAt(pair.miso.ss, pair.miso.es, ANN.BIT, [
        `Status register byte ${(this.cmdstate % 2) + 1}: 0x${hex(pair.miso.value, 2)}`,
      ]);
      this.esCmd = pair.miso.es;
    }
    this.cmdstate++;
  }

  private handleRems2(command: FlashCommand, pair: WordPair): void {
    if (this.cmdstate === 1) this.emitCommandByte(command, pair.mosi);
    else {
      const [, device] = dualBytes(pair.mosi.value, pair.miso.value);
      this.deviceId = device;
      this.putAt(pair.miso.ss, pair.miso.es, ANN.FIELD, [`Device ID: 0x${hex(device, 2)}`]);
      this.esCmd = pair.miso.es;
      this.putCommand(command, this.vendorDeviceTexts(command));
      this.state = null;
    }
    if (this.state) this.cmdstate++;
  }

  private handlePair(pair: WordPair): void {
    if (this.state === null) {
      const command = FLASH_BY_CODE.get(pair.mosi.value);
      if (!command) {
        this.putAt(pair.mosi.ss, pair.mosi.es, ANN.BIT, [`Unknown command: 0x${hex(pair.mosi.value, 2)}`]);
        return;
      }
      this.state = command;
      this.cmdstate = 1;
      this.addr = 0;
      this.data = [];
      this.ids = [];
    }
    const command = this.state;
    if (!command) return;
    switch (command.code) {
      case 0x01:
        this.handleWriteStatus(command, pair);
        break;
      case 0x02:
      case 0x82:
      case 0x85:
        this.handleWriteLike(command, pair);
        break;
      case 0x03:
        this.handleRead(command, pair);
        break;
      case 0x04:
        this.handleNoData(command, pair, () => {
          this.writeState = false;
        });
        break;
      case 0x05:
      case 0x35:
        this.handleReadStatus(command, pair);
        break;
      case 0x06:
        this.handleNoData(command, pair, () => {
          this.writeState = true;
        });
        break;
      case 0x0b:
        this.handleFastRead(command, pair);
        break;
      case 0x20:
        this.handleSectorErase(command, pair);
        break;
      case 0x2b:
        this.handleSecurityRead(command, pair);
        break;
      case 0x2f:
        this.handleSecurityWrite(command, pair);
        break;
      case 0x60:
      case 0xc7:
        this.handleNoData(command, pair);
        if (this.cmdstate === 2 && !this.writeState)
          this.putAt(pair.mosi.ss, pair.mosi.es, ANN.WARNING, ['Warning: WREN might be missing']);
        break;
      case 0x70:
      case 0x80:
      case 0xad:
      case 0xb1:
      case 0xb9:
      case 0xc1:
        this.handleNoData(command, pair);
        break;
      case 0x90:
        this.handleRems(command, pair);
        break;
      case 0x9f:
        this.handleReadId(command, pair);
        break;
      case 0xab:
        this.handleRelease(command, pair);
        break;
      case 0xbb:
        this.handleDualRead(command, pair);
        break;
      case 0xd7:
        this.handleStatusRead(command, pair);
        break;
      case 0xd8:
        this.handleBlockErase(command, pair);
        break;
      case 0xef:
        this.handleRems2(command, pair);
        break;
    }
  }

  private splitWord(ss: bigint, es: bigint, mosi: number | null, miso: number | null): WordPair[] {
    const width = (value: number | null): number =>
      value === null || value === 0 ? 1 : Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
    const count = Math.max(width(mosi), width(miso)),
      span = es - ss,
      pairs: WordPair[] = [];
    const byte = (value: number | null, index: number): WordByte => {
      const byteSs = ss + (span * BigInt(index)) / BigInt(count),
        byteEs = ss + (span * BigInt(index + 1)) / BigInt(count),
        shift = 8 * (count - index - 1);
      return {
        value: typeof value === 'number' ? Math.floor(value / 2 ** shift) & 0xff : 0,
        ss: byteSs,
        es: byteEs,
      };
    };
    for (let index = 0; index < count; index++) pairs.push({ mosi: byte(mosi, index), miso: byte(miso, index) });
    return pairs;
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as SPIProtocolPacket;
    if (!Array.isArray(packet)) return;
    if (packet[0] === 'WARNING') {
      if (this.state !== null) this.endTransaction(this.lastWordEs ?? ss);
      return;
    }
    if (packet[0] !== 'WORD') return;
    if (this.lastWordEs !== null && ss > this.lastWordEs) {
      const gap = ss - this.lastWordEs,
        span = this.lastWordEs - (this.lastWordSs ?? this.lastWordEs);
      if (gap > span / 4n + 1n) this.endTransaction(this.lastWordEs);
    }
    const mosi = typeof packet[1] === 'number' ? packet[1] : null,
      miso = typeof packet[2] === 'number' ? packet[2] : null;
    for (const pair of this.splitWord(ss, es, mosi, miso)) {
      this.esCmd = es;
      this.handlePair(pair);
    }
    this.lastWordSs = ss;
    this.lastWordEs = es;
  }

  onEof(): void {
    if (this.lastWordEs !== null) this.endTransaction(this.lastWordEs);
  }
}

export default SpiflashDecoder;
