import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

type Direction = 'sc' | 'cs';
type AnnotationName = 'server-id' | 'function' | 'crc' | 'address' | 'data' | 'length' | 'error' | 'error-indication';
const RXTX = ['RX', 'TX'] as const;
const ANNOTATION_CLASS: Readonly<Record<string, number>> = {
  'sc-server-id': 0,
  'sc-function': 1,
  'sc-crc': 2,
  'sc-address': 3,
  'sc-data': 4,
  'sc-length': 5,
  'sc-error': 6,
  'cs-server-id': 7,
  'cs-function': 8,
  'cs-crc': 9,
  'cs-address': 10,
  'cs-data': 11,
  'cs-length': 12,
  'cs-error': 13,
  'error-indication': 14,
};
const DIAGNOSTIC_SUBFUNCTIONS: Readonly<Record<number, string>> = {
  0: 'Return Query data',
  1: 'Restart Communications Option',
  2: 'Return Diagnostics Register',
  3: 'Change ASCII Input Delimiter',
  4: 'Force Listen Only Mode',
  10: 'Clear Counters and Diagnostic Register',
  11: 'Return Bus Message Count',
  12: 'Return Bus Communication Error Count',
  13: 'Return Bus Exception Error Count',
  14: 'Return Slave Message Count',
  15: 'Return Slave No Response Count',
  16: 'Return Slave NAK Count',
  17: 'Return Slave Busy Count',
  18: 'Return Bus Character Overrun Count',
  20: 'Return Overrun Counter and Flag',
};
const COIL_ADDRESS_BASE = 1;
const DISCRETE_INPUT_ADDRESS_BASE = 10_001;
const INPUT_REGISTER_ADDRESS_BASE = 30_001;
const HOLDING_REGISTER_ADDRESS_BASE = 40_001;
const FUNCTION_NAMES: Readonly<Record<number, string>> = {
  1: 'Read Coils',
  2: 'Read Discrete Inputs',
  3: 'Read Holding Registers',
  4: 'Read Input Registers',
  5: 'Write Single Coil',
  6: 'Write Single Register',
  7: 'Read Exception Status',
  8: 'Diagnostic',
  11: 'Get Com Event Counter',
  12: 'Get Com Event Log',
  15: 'Write Multiple Coils',
  16: 'Write Multiple Registers',
  17: 'Report Slave ID',
  20: 'Read File Record',
  21: 'Write File Record',
  22: 'Mask Write Register',
  23: 'Read/Write Multiple Registers',
  24: 'Read FIFO Queue',
  43: 'Read Device Identification/Encapsulated Interface Transport',
};
const ERROR_CODES: Readonly<Record<number, string>> = {
  1: 'Illegal Function',
  2: 'Illegal Data Address',
  3: 'Illegal Data Value',
  4: 'Slave Device Failure',
  5: 'Acknowledge',
  6: 'Slave Device Busy',
  8: 'Memory Parity Error',
  10: 'Gateway Path Unavailable',
  11: 'Gateway Target Device failed to respond',
};

function referenceAddress(functionCode: number, address: number): number {
  if (functionCode === 2) return DISCRETE_INPUT_ADDRESS_BASE + address;
  if (functionCode === 4) return INPUT_REGISTER_ADDRESS_BASE + address;
  if (functionCode === 3 || functionCode === 6 || functionCode === 16 || functionCode === 22 || functionCode === 23)
    return HOLDING_REGISTER_ADDRESS_BASE + address;
  return COIL_ADDRESS_BASE + address;
}

class NoMoreData extends Error {}

interface DataByte {
  readonly start: bigint;
  readonly end: bigint;
  readonly value: number;
}

export type ModbusProtocolPacket = ['ADU', direction: Direction, bytes: number[]];

abstract class ModbusAdu {
  readonly data: DataByte[] = [];
  lastRead: bigint;
  lastBytePut = -1;
  minimumLength = 4;
  startNewFrame = false;
  hasError = false;
  protected crcComplete = false;
  private protocolEmitted = false;

  constructor(
    protected readonly parent: ModbusDecoder,
    start: bigint,
    readonly direction: Direction,
  ) {
    this.lastRead = start;
  }

  abstract parse(): void;

  addData(start: bigint, end: bigint, packet: readonly unknown[]): void {
    this.lastRead = end;
    if (packet[0] !== 'DATA') return;
    this.data.push({ start, end, value: (packet[2] as readonly [number, unknown])[0] });
    try {
      this.parse();
    } catch (error) {
      if (!(error instanceof NoMoreData)) throw error;
    }
    this.emitProtocol();
  }

  private emitProtocol(): void {
    if (!this.crcComplete || this.protocolEmitted || !this.data.length) return;
    this.protocolEmitted = true;
    this.parent.putProtocol(
      this.data[0]!.start,
      this.data[this.data.length - 1]!.end,
      this.direction,
      this.data.map((byte) => byte.value),
    );
  }

  puti(byteToPut: number, annotation: AnnotationName, message: string): void {
    if (byteToPut > this.data.length - 1) throw new NoMoreData();
    if (annotation === 'error') this.hasError = true;
    if (byteToPut > this.lastBytePut) {
      const first = this.data[this.lastBytePut + 1]!;
      this.parent.putAnnotation(first.start, this.data[byteToPut]!.end, `${this.direction}-${annotation}`, message);
      this.lastBytePut = byteToPut;
      throw new NoMoreData();
    }
  }

  putl(annotation: AnnotationName, message: string | ((value: number) => string), maximum: number | null = null): void {
    const index = this.data.length - 1;
    if (maximum !== null && index > maximum) return;
    const value = this.data[index]!.value;
    const text =
      typeof message === 'function'
        ? message(value)
        : message
            .replaceAll('{:08b}', value.toString(2).padStart(8, '0'))
            .replaceAll('{:02X}', value.toString(16).toUpperCase().padStart(2, '0'))
            .replaceAll('{:X}', value.toString(16).toUpperCase());
    this.puti(index, annotation, text);
  }

  close(overflow: bigint): void {
    if (this.data.length < this.minimumLength) {
      if (!this.data.length) return;
      const last = this.lastBytePut >= 0 ? this.data[this.lastBytePut]! : this.data[this.data.length - 1]!;
      this.parent.putAnnotation(last.end, overflow, `${this.direction}-error`, 'Message too short or not finished');
      this.hasError = true;
    }
    if (this.hasError && this.parent.options.scchannel !== this.parent.options.cschannel)
      this.parent.putAnnotation(
        this.data[0]!.start,
        this.data[this.data.length - 1]!.end,
        'error-indication',
        'Frame contains error',
      );
    if (this.data.length > 256) {
      try {
        this.puti(this.data.length - 1, 'error', 'Modbus data frames are limited to 256 bytes');
      } catch (error) {
        if (!(error instanceof NoMoreData)) throw error;
      }
    }
  }

  halfWord(start: number): number {
    const index = start < 0 ? this.data.length + start : start;
    if (index + 1 > this.data.length - 1) throw new NoMoreData();
    return this.data[index]!.value * 0x100 + this.data[index + 1]!.value;
  }

  private calcCrc(lastByte: number): readonly [number, number] {
    if (lastByte < 3) throw new Error('Could not calculate CRC: message too short');
    let result = 0xffff;
    for (const byte of this.data.slice(0, lastByte - 1)) {
      result ^= byte.value;
      for (let bit = 0; bit < 8; bit++) {
        const low = result & 1;
        result >>>= 1;
        if (low) result ^= 0xa001;
      }
    }
    return [result & 0xff, (result >>> 8) & 0xff];
  }

  checkCrc(byteToPut: number): void {
    const [first, second] = this.calcCrc(byteToPut);
    if (byteToPut > this.data.length - 1) {
      this.puti(byteToPut, 'crc', 'CRC correct');
      return;
    }
    this.crcComplete = true;
    if (this.data[this.data.length - 2]!.value === first && this.data[this.data.length - 1]!.value === second)
      this.puti(byteToPut, 'crc', 'CRC correct');
    else this.puti(byteToPut, 'error', `CRC should be ${first} ${second}`);
  }

  parseWriteSingleCoil(): void {
    this.minimumLength = 8;
    this.puti(1, 'function', 'Function 5: Write Single Coil');
    const address = this.halfWord(2);
    this.puti(3, 'address', `Address 0x${address.toString(16).toUpperCase()} / ${referenceAddress(5, address)}`);
    const raw = this.halfWord(4);
    const value = raw === 0 ? 'Coil Value OFF' : raw === 0xff00 ? 'Coil Value ON' : 'Invalid Coil Value';
    this.puti(5, 'data', value);
    this.checkCrc(7);
  }

  parseWriteSingleRegister(): void {
    this.minimumLength = 8;
    this.puti(1, 'function', 'Function 6: Write Single Register');
    const address = this.halfWord(2);
    this.puti(3, 'address', `Address 0x${address.toString(16).toUpperCase()} / ${referenceAddress(6, address)}`);
    const value = this.halfWord(4);
    this.puti(5, 'data', `Register Value 0x${value.toString(16).toUpperCase()} / ${value}`);
    this.checkCrc(7);
  }

  parseDiagnostics(): void {
    this.minimumLength = 8;
    this.puti(1, 'function', 'Function 8: Diagnostics');
    const subfunction = this.halfWord(2);
    this.puti(
      3,
      'data',
      `Subfunction ${subfunction}: ${DIAGNOSTIC_SUBFUNCTIONS[subfunction] ?? 'Reserved subfunction'}`,
    );
    const data = this.halfWord(4);
    this.puti(5, 'data', `Data Field: ${data} / 0x${data.toString(16).toUpperCase().padStart(4, '0')}`);
    this.checkCrc(7);
  }

  parseMaskWriteRegister(): void {
    this.minimumLength = 10;
    this.puti(1, 'function', 'Function 22: Mask Write Register');
    const address = this.halfWord(2);
    this.puti(3, 'address', `Address 0x${address.toString(16).toUpperCase()} / ${referenceAddress(22, address)}`);
    this.halfWord(4);
    this.puti(
      5,
      'data',
      `AND mask: ${this.data[4]!.value.toString(2).padStart(8, '0')} ${this.data[5]!.value.toString(2).padStart(8, '0')}`,
    );
    this.halfWord(6);
    this.puti(
      7,
      'data',
      `OR mask: ${this.data[6]!.value.toString(2).padStart(8, '0')} ${this.data[7]!.value.toString(2).padStart(8, '0')}`,
    );
    this.checkCrc(9);
  }

  parseNotImplemented(): void {
    const functionCode = this.data[1]!.value;
    const names: Readonly<Record<number, string>> = {
      20: 'Read File Record',
      21: 'Write File Record',
      24: 'Read FIFO Queue',
      43: 'Read Device Identification/Encapsulated Interface Transport',
    };
    this.puti(1, 'function', `Function ${functionCode}: ${names[functionCode] ?? 'Unknown function'} (not supported)`);
    this.putl('data', 'This function is not currently supported');
  }
}

class ModbusSc extends ModbusAdu {
  parse(): void {
    try {
      const server = this.data[0]!.value;
      this.puti(0, 'server-id', 1 <= server && server <= 247 ? `Slave ID: ${server}` : 'Slave ID {} is invalid');
      const fn = this.data[1]!.value;
      if (fn === 1 || fn === 2) this.parseReadBits();
      else if (fn === 3 || fn === 4 || fn === 23) this.parseReadRegisters();
      else if (fn === 5) this.parseWriteSingleCoil();
      else if (fn === 6) this.parseWriteSingleRegister();
      else if (fn === 7) this.parseReadExceptionStatus();
      else if (fn === 8) this.parseDiagnostics();
      else if (fn === 11) this.parseCommEventCounter();
      else if (fn === 12) this.parseCommEventLog();
      else if (fn === 15 || fn === 16) this.parseWriteMultiple();
      else if (fn === 17) this.parseReportServerId();
      else if (fn === 22) this.parseMaskWriteRegister();
      else if (fn === 21 || fn === 24 || fn === 43) this.parseNotImplemented();
      else if (fn > 0x80) this.parseError();
      else {
        this.puti(1, 'error', `Unknown function: ${fn}`);
        this.putl('error', 'Unknown function');
      }
      this.putl('error', 'Message too long');
    } catch (error) {
      if (!(error instanceof NoMoreData)) throw error;
    }
  }

  private parseReadBits(): void {
    const fn = this.data[1]!.value;
    this.puti(1, 'function', fn === 1 ? 'Function 1: Read Coils' : 'Function 2: Read Discrete Inputs');
    const count = this.data[2]!.value;
    this.minimumLength = 5 + count;
    this.puti(2, 'length', `Byte count: ${count}`);
    this.putl('data', (value) => value.toString(2).padStart(8, '0'), count + 2);
    this.checkCrc(count + 4);
  }

  private parseReadRegisters(): void {
    const fn = this.data[1]!.value;
    if (fn === 3) this.puti(1, 'function', 'Function 3: Read Holding Registers');
    else if (fn === 4) this.puti(1, 'function', 'Function 4: Read Input Registers');
    else if (fn === 23) this.puti(1, 'function', 'Function 23: Read/Write Multiple Registers');
    const count = this.data[2]!.value;
    this.minimumLength = 5 + count;
    if (count % 2 === 0) this.puti(2, 'length', `Byte count: ${count}`);
    else this.puti(2, 'error', `Error: Odd byte count (${count})`);
    if (this.data.length % 2 === 1) {
      const value = this.halfWord(-2);
      this.putl('data', `0x${value.toString(16).toUpperCase().padStart(4, '0')} / ${value}`, count + 2);
    } else throw new NoMoreData();
    this.checkCrc(count + 4);
  }

  private parseReadExceptionStatus(): void {
    this.puti(1, 'function', 'Function 7: Read Exception Status');
    const status = this.data[2]!.value;
    this.puti(2, 'data', `Exception status: ${status.toString(2).padStart(8, '0')}`);
    this.checkCrc(4);
  }

  private parseCommEventCounter(): void {
    this.puti(1, 'function', 'Function 11: Get Comm Event Counter');
    const status = this.halfWord(2);
    if (status === 0) this.puti(3, 'data', 'Status: not busy');
    else if (status === 0xffff) this.puti(3, 'data', 'Status: busy');
    else this.puti(3, 'error', `Bad status: 0x${status.toString(16).toUpperCase().padStart(4, '0')}`);
    const count = this.halfWord(4);
    this.puti(5, 'data', `Event Count: ${count}`);
    this.checkCrc(7);
  }

  private parseCommEventLog(): void {
    this.puti(1, 'function', 'Function 12: Get Comm Event Log');
    const count = this.data[2]!.value;
    this.puti(2, 'length', `Bytecount: ${count}`);
    this.minimumLength = 5 + count;
    const status = this.halfWord(3);
    if (status === 0) this.puti(4, 'data', 'Status: not busy');
    else if (status === 0xffff) this.puti(4, 'data', 'Status: busy');
    else this.puti(4, 'error', `Bad status: 0x${status.toString(16).toUpperCase().padStart(4, '0')}`);
    const eventCount = this.halfWord(5);
    this.puti(6, 'data', `Event Count: ${eventCount}`);
    const messageCount = this.halfWord(7);
    this.puti(8, 'data', `Message Count: ${messageCount}`);
    this.putl('data', (value) => `Event: 0x${value.toString(16).toUpperCase().padStart(2, '0')}`, count + 2);
    this.checkCrc(count + 4);
  }

  private parseWriteMultiple(): void {
    const fn = this.data[1]!.value;
    const coils = fn === 15;
    const unit = coils ? 'Coils' : 'Registers',
      maximum = coils ? 0x07b0 : 0x007b;
    this.puti(1, 'function', `Function ${fn}: Write Multiple ${unit}`);
    const start = this.halfWord(2);
    this.puti(3, 'address', `Start at address 0x${start.toString(16).toUpperCase()} / ${referenceAddress(fn, start)}`);
    const quantity = this.halfWord(4);
    if (quantity <= maximum) this.puti(5, 'data', `Write ${quantity} ${unit}`);
    else this.puti(5, 'error', `Bad value: ${quantity} ${unit}. Max is ${maximum}`);
    this.checkCrc(7);
  }

  private parseReportServerId(): void {
    this.puti(1, 'function', 'Function 17: Report Server ID');
    const count = this.data[2]!.value;
    this.puti(2, 'length', `Data is ${count} bytes long`);
    this.puti(3, 'data', `serverID: ${this.data[3]!.value}`);
    const run = this.data[4]!.value;
    if (run === 0) this.puti(4, 'data', 'Run Indicator status: Off');
    else if (run === 0xff) this.puti(4, 'data', 'Run Indicator status: On');
    else this.puti(4, 'error', `Bad Run Indicator status: 0x${run.toString(16).toUpperCase()}`);
    this.putl('data', (value) => `Device specific data: ${value}, "${String.fromCharCode(value)}"`, 2 + count);
    this.checkCrc(4 + count);
  }

  private parseError(): void {
    const functionCode = this.data[1]!.value - 0x80;
    this.puti(
      1,
      'function',
      `Error for function ${functionCode}: ${FUNCTION_NAMES[functionCode] ?? 'Unknown function'}`,
    );
    const error = this.data[2]!.value;
    this.puti(2, 'data', `Error ${error}: ${ERROR_CODES[error] ?? 'Unknown'}`);
    this.checkCrc(4);
  }
}

class ModbusCs extends ModbusAdu {
  parse(): void {
    try {
      const server = this.data[0]!.value;
      const message =
        server === 0
          ? 'Broadcast message'
          : 1 <= server && server <= 247
            ? `Slave ID: ${server}`
            : 248 <= server && server <= 255
              ? `Slave ID: ${server} (reserved address)`
              : '';
      this.puti(0, 'server-id', message);
      const fn = this.data[1]!.value;
      if (fn >= 1 && fn <= 4) this.parseReadDataCommand();
      if (fn === 5) this.parseWriteSingleCoil();
      if (fn === 6) this.parseWriteSingleRegister();
      if (fn === 7 || fn === 11 || fn === 12 || fn === 17) this.parseSingleByteRequest();
      else if (fn === 8) this.parseDiagnostics();
      if (fn === 15 || fn === 16) this.parseWriteMultiple();
      else if (fn === 22) this.parseMaskWriteRegister();
      else if (fn === 23) this.parseReadWriteRegisters();
      else if (fn === 21 || fn === 24 || fn === 43) this.parseNotImplemented();
      else {
        this.puti(1, 'error', `Unknown function: ${fn}`);
        this.putl('error', 'Unknown function');
      }
      this.putl('error', 'Message too long');
    } catch (error) {
      if (!(error instanceof NoMoreData)) throw error;
    }
  }

  private parseReadDataCommand(): void {
    this.minimumLength = 8;
    const fn = this.data[1]!.value;
    const names: Readonly<Record<number, string>> = {
      1: 'Read Coils',
      2: 'Read Discrete Inputs',
      3: 'Read Holding Registers',
      4: 'Read Input Registers',
    };
    this.puti(1, 'function', `Function ${fn}: ${names[fn]}`);
    const start = this.halfWord(2);
    this.puti(3, 'address', `Start at address 0x${start.toString(16).toUpperCase()} / ${referenceAddress(fn, start)}`);
    this.puti(5, 'length', `Read ${this.halfWord(4)} units of data`);
    this.checkCrc(7);
  }

  private parseSingleByteRequest(): void {
    const fn = this.data[1]!.value;
    const names: Readonly<Record<number, string>> = {
      7: 'Read Exception Status',
      11: 'Get Comm Event Counter',
      12: 'Get Comm Event Log',
      17: 'Report Slave ID',
    };
    this.puti(1, 'function', `Function ${fn}: ${names[fn]}`);
    this.checkCrc(3);
  }

  private parseWriteMultiple(): void {
    const fn = this.data[1]!.value;
    const coils = fn === 15;
    const unit = coils ? 'Coils' : 'Registers',
      maximum = coils ? 0x07b0 : 0x007b,
      ratio = coils ? 1 / 8 : 2;
    this.puti(1, 'function', `Function ${fn}: Write Multiple ${unit}`);
    const start = this.halfWord(2);
    this.puti(3, 'address', `Start at address 0x${start.toString(16).toUpperCase()} / ${referenceAddress(fn, start)}`);
    const quantity = this.halfWord(4);
    if (quantity <= maximum) this.puti(5, 'length', `Write ${quantity} ${unit}`);
    else this.puti(5, 'error', `Bad value: ${quantity} ${unit}. Max is ${maximum}`);
    const expected = Math.ceil(quantity * ratio);
    const count = this.data[6]!.value;
    if (count === expected) this.puti(6, 'length', `Byte count: ${count}`);
    else this.puti(6, 'error', `Bad byte count, is ${count}, should be ${expected}`);
    this.minimumLength = count + 9;
    this.putl('data', 'Value 0x{:X}', 6 + count);
    this.checkCrc(count + 8);
  }

  private parseReadWriteRegisters(): void {
    this.minimumLength = 13;
    this.puti(1, 'function', 'Function 23: Read/Write Multiple Registers');
    const readAddress = this.halfWord(2);
    this.puti(
      3,
      'address',
      `Read starting at address 0x${readAddress.toString(16).toUpperCase()} / ${referenceAddress(23, readAddress)}`,
    );
    this.puti(5, 'length', `Read ${this.halfWord(4)} units of data`);
    const writeAddress = this.halfWord(6);
    this.puti(
      7,
      'address',
      `Write starting at address 0x${writeAddress.toString(16).toUpperCase()} / ${referenceAddress(23, writeAddress)}`,
    );
    const quantity = this.halfWord(8);
    this.puti(9, 'length', `Write ${quantity} registers`);
    const expected = quantity * 2;
    const count = this.data[10]!.value;
    if (count === expected) this.puti(10, 'length', `Byte count: ${count}`);
    else this.puti(10, 'error', `Bad byte count, is ${count}, should be ${expected}`);
    this.minimumLength = count + 13;
    this.putl('data', 'Data, value 0x{:02X}', 10 + count);
    this.checkCrc(count + 12);
  }
}

export class ModbusDecoder extends Decoder<{
  scchannel: string;
  cschannel: string;
  framegap: number;
}> {
  static descriptor = descriptor;
  private aduSc: ModbusSc | null = null;
  private aduCs: ModbusCs | null = null;
  private bitLength: bigint | null = null;
  private outAnn = -1;
  private outProtocol = -1;

  override reset(): void {
    this.aduSc = null;
    this.aduCs = null;
    this.bitLength = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
  }

  putAnnotation(start: bigint, end: bigint, name: string, message: string): void {
    const classIndex = ANNOTATION_CLASS[name];
    if (classIndex !== undefined) this.put(start, end, this.outAnn, [classIndex, [message]]);
  }

  putProtocol(start: bigint, end: bigint, direction: Direction, bytes: number[]): void {
    this.put(start, end, this.outProtocol, ['ADU', direction, bytes] satisfies ModbusProtocolPacket);
  }

  private decodeAdu(ss: bigint, es: bigint, packet: readonly unknown[], direction: Direction): void {
    if (this.bitLength === null) {
      if (packet[0] !== 'STARTBIT' && packet[0] !== 'STOPBIT') return;
      this.bitLength = es - ss;
    }
    if (direction === 'sc') this.aduSc ??= new ModbusSc(this, ss, 'sc');
    else this.aduCs ??= new ModbusCs(this, ss, 'cs');
    const adu = direction === 'sc' ? this.aduSc! : this.aduCs!;
    if (adu.startNewFrame) {
      if (direction === 'sc') this.aduSc = new ModbusSc(this, ss, 'sc');
      else this.aduCs = new ModbusCs(this, ss, 'cs');
    }
    const current = direction === 'sc' ? this.aduSc! : this.aduCs!;
    if (ss - current.lastRead <= this.bitLength! * BigInt(this.options.framegap)) {
      current.addData(ss, es, packet);
    } else {
      if (current.data.length) current.close(current.data[current.data.length - 1]!.end + this.bitLength! * 3n);
      current.startNewFrame = true;
      this.decodeAdu(ss, es, packet, direction);
    }
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as readonly unknown[];
    if (packet[0] !== 'STARTBIT' && packet[0] !== 'DATA' && packet[0] !== 'STOPBIT') return;
    const direction = RXTX[packet[1] as number];
    if (direction === this.options.scchannel) this.decodeAdu(ss, es, packet, 'sc');
    if (direction === this.options.cschannel) this.decodeAdu(ss, es, packet, 'cs');
  }

  onEof(): void {
    if (this.bitLength === null) return;
    for (const adu of [this.aduSc, this.aduCs]) {
      if (adu?.data.length) adu.close(adu.data[adu.data.length - 1]!.end + this.bitLength * 3n);
    }
  }
}

export default ModbusDecoder;
