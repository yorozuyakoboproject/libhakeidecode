import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';
import { ERROR_MESSAGES, FIFO_MODES, NUMBER_BYTES, OPERATIONS, RATE_CODES, REGISTERS } from './tables.js';

const ANN = Object.freeze({
  READ: 0,
  WRITE: 1,
  MULTIPLE: 2,
  REG_ADDRESS: 3,
  REG_DATA: 4,
  WARNING: 5,
});
const READ = 1,
  WRITE = 0;

interface WireByte {
  readonly value: number | null;
  readonly ss: bigint;
  readonly es: bigint;
}

interface BitRecord {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

type BitKind = 'enable' | 'source' | 'interrupt' | 'acdc' | 'unused' | 'other';

interface BitDefinition {
  readonly name: string;
  readonly kind: BitKind;
  readonly values?: Readonly<Record<0 | 1, readonly string[]>>;
}

function bit(name: string, kind: BitKind, values?: Readonly<Record<0 | 1, readonly string[]>>): BitDefinition {
  return { name, kind, values };
}

function bitTexts(definition: BitDefinition, value: number): readonly string[] {
  let texts: readonly string[];
  if (definition.kind === 'enable')
    texts = value === 1 ? ['Enable %s', 'En %s', '%s '] : ['Disable %s', 'Dis %s', '!%s '];
  else if (definition.kind === 'source')
    texts = value === 1 ? ['Involve %s', 'Inv %s', '%s'] : ['Not involve %s', 'Not inv %s', '!%s'];
  else if (definition.kind === 'interrupt') texts = value === 1 ? ['INT2 %s', 'I2: %s '] : ['INT1 %s', 'I1:%s '];
  else if (definition.kind === 'acdc') texts = value === 1 ? ['%s ac', 'ac'] : ['%s dc', 'dc'];
  else if (definition.kind === 'unused') texts = ['N/A'];
  else texts = definition.values?.[value as 0 | 1] ?? ['N/A'];
  return texts.map((text) => text.replaceAll('%s', definition.name));
}

function wordWidth(value: number | null): number {
  if (value === null || value === 0) return 1;
  return Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
}

function byteBits(byte: WireByte): BitRecord[] {
  const span = byte.es - byte.ss;
  return Array.from({ length: 8 }, (_, index) => ({
    value: ((byte.value ?? 0) >>> (7 - index)) & 1,
    ss: byte.ss + (span * BigInt(index)) / 8n,
    es: byte.ss + (span * BigInt(index + 1)) / 8n,
  }));
}

export class Adxl345Decoder extends Decoder {
  static descriptor = descriptor;
  private outAnn = -1;
  private state: 'idle' | 'address' | 'data' = 'idle';
  private operation = WRITE;
  private multiple = false;
  private address = 0;
  private pending: BitRecord[] = [];
  private storedData = -1;
  private dataStart: bigint | null = null;
  private startIndex = 0n;
  private currentSs = 0n;
  private currentEs = 0n;
  private samplesPerBit = 0n;
  private lastWordEnd: bigint | null = null;
  private lastWordSpan = 0n;
  private previousCs: boolean | null = null;

  override reset(): void {
    this.state = 'idle';
    this.operation = WRITE;
    this.multiple = false;
    this.address = 0;
    this.pending = [];
    this.storedData = -1;
    this.dataStart = null;
    this.startIndex = 0n;
    this.currentSs = 0n;
    this.currentEs = 0n;
    this.samplesPerBit = 0n;
    this.lastWordEnd = null;
    this.lastWordSpan = 0n;
    this.previousCs = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putCurrent(classIndex: number, texts: readonly string[], ss = this.dataStart ?? this.currentSs): void {
    this.put(ss, this.currentEs, this.outAnn, [classIndex, texts]);
  }

  private putBit(classIndex: number, texts: readonly string[], index: number): void {
    const start = (this.dataStart ?? this.currentSs) + BigInt(index) * this.samplesPerBit;
    this.put(start, start + this.samplesPerBit, this.outAnn, [classIndex, texts]);
  }

  private putBitRange(classIndex: number, texts: readonly string[], startIndex: number, stopIndex: number): void {
    const reverse = (index: number): number => 7 - index,
      first = Math.min(reverse(startIndex), reverse(stopIndex)),
      last = Math.max(reverse(startIndex), reverse(stopIndex)),
      start = (this.dataStart ?? this.currentSs) + BigInt(first) * this.samplesPerBit,
      end = start + BigInt(last - first + 1) * this.samplesPerBit;
    this.put(start, end, this.outAnn, [classIndex, texts]);
  }

  private interpretBits(data: number, definitions: readonly (BitDefinition | null)[]): number[] {
    const values = Array.from({ length: 8 }, (_, index) => (data >>> (7 - index)) & 1);
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index];
      if (definition) this.putBit(ANN.REG_DATA, bitTexts(definition, values[index]!), index);
    }
    return [...values].reverse();
  }

  private decimalNumber(values: readonly number[], start: number, stop: number): number {
    let result = 0;
    for (let index = start, offset = 0; index <= stop; index++, offset++) result |= values[index]! << offset;
    return result;
  }

  private beginTransaction(): void {
    this.state = 'address';
    this.pending = [];
    this.dataStart = null;
  }

  private endTransaction(): void {
    this.state = 'idle';
    this.pending = [];
    this.dataStart = null;
  }

  private commitAddress(byte: WireByte): void {
    const bits = byteBits(byte);
    this.operation = bits[0]!.value ? READ : WRITE;
    this.put(bits[0]!.ss, bits[0]!.es, this.outAnn, [
      this.operation === READ ? ANN.READ : ANN.WRITE,
      OPERATIONS[this.operation]!,
    ]);
    this.multiple = bits[1]!.value === 1;
    this.put(bits[1]!.ss, bits[1]!.es, this.outAnn, [ANN.MULTIPLE, NUMBER_BYTES[this.multiple ? 1 : 0]!]);
    this.address = 0;
    for (let index = 2; index < 8; index++) this.address = (this.address << 1) | bits[index]!.value;
    const upper = this.address.toString(16).toUpperCase().padStart(2, '0');
    this.put(bits[2]!.ss, bits[7]!.es, this.outAnn, [
      ANN.REG_ADDRESS,
      [`ADDRESS: 0x${upper}`, `ADDR: 0x${upper}`, `0x${upper}`],
    ]);
    this.state = 'data';
    this.pending = [];
    this.dataStart = null;
  }

  private handleRegWithScaling(
    data: number,
    factor: number,
    name: string,
    unit: string,
    error?: readonly string[],
  ): void {
    if (data === 0 && error) this.putCurrent(ANN.WARNING, error);
    else {
      const result = ((data * factor) / 1000).toFixed(6);
      this.putCurrent(ANN.REG_DATA, [`${name}: ${result} ${unit}`, `${result} ${unit}`]);
    }
  }

  private handleReg0x2c(data: number): void {
    const definitions = [
      bit('', 'unused'),
      bit('', 'unused'),
      bit('', 'unused'),
      bit('', 'other', {
        0: ['Normal operation', 'Normal op', 'Norm op'],
        1: ['Reduce power', 'Reduce pw', 'Red pw'],
      }),
    ];
    const values = this.interpretBits(data, definitions),
      rate = this.decimalNumber(values, 0, 3);
    this.putBitRange(ANN.REG_DATA, [RATE_CODES[rate]!.toFixed(6)], 3, 0);
  }

  private handleReg0x2d(data: number): void {
    const definitions = [
      bit('', 'unused'),
      bit('', 'unused'),
      bit('', 'other', { 0: ['Unlink'], 1: ['Link'] }),
      bit('AUTO_SLEEP', 'enable'),
      bit('', 'other', { 0: ['Standby mode', 'Standby'], 1: ['Measurement mode', 'Measurement', 'Meas'] }),
      bit('', 'other', { 0: ['Normal mode', 'Normal', 'Nrm'], 1: ['Sleep mode', 'Sleep', 'Slp'] }),
    ];
    const values = this.interpretBits(data, definitions),
      wakeup = this.decimalNumber(values, 0, 1),
      frequency = 2 ** (~wakeup & 0x03);
    this.putBitRange(ANN.REG_DATA, [`${frequency} Hz`], 1, 0);
  }

  private handleReg0x31(data: number): void {
    const definitions = [
      bit('SELF_TEST', 'enable'),
      bit('', 'other', { 0: ['4-wire SPI', '4-SPI'], 1: ['3-wire SPI', '3-SPI'] }),
      bit('', 'other', { 0: ['INT ACT HIGH', 'INT HIGH'], 1: ['INT ACT LOW', 'INT LOW'] }),
      bit('', 'unused'),
      bit('', 'other', { 0: ['10-bit mode', '10-bit'], 1: ['Full resolution', 'Full res'] }),
      bit('', 'other', { 0: ['LSB mode', 'LSB'], 1: ['MSB mode', 'MSB'] }),
    ];
    const values = this.interpretBits(data, definitions),
      range = this.decimalNumber(values, 0, 1);
    this.putBitRange(ANN.REG_DATA, [`+/-${2 ** (range + 1)} g`], 1, 0);
  }

  private handleAxis(data: number, axis: string): void {
    if (this.storedData !== -1) {
      const shifted = data << 8,
        combined = this.storedData | shifted;
      this.put(this.startIndex, this.currentEs, this.outAnn, [
        ANN.REG_DATA,
        [`${axis}: 0x${combined.toString(16).toUpperCase().padStart(4, '0')}`, String(shifted)],
      ]);
      this.storedData = -1;
    } else this.putCurrent(ANN.REG_DATA, [String(data)]);
  }

  private handleRegister(address: number, data: number): void {
    switch (address) {
      case 0x1d:
        this.handleRegWithScaling(data, 62.5, 'Threshold', 'g', ERROR_MESSAGES.undesirable);
        break;
      case 0x1e:
        this.handleRegWithScaling(data, 15.6, 'OFSX', 'g');
        break;
      case 0x1f:
        this.handleRegWithScaling(data, 15.6, 'OFSY', 'g');
        break;
      case 0x20:
        this.handleRegWithScaling(data, 15.6, 'OFSZ', 'g');
        break;
      case 0x21:
        this.handleRegWithScaling(data, 0.625, 'Duration', 's', ERROR_MESSAGES.dis_single_double);
        break;
      case 0x22:
        this.handleRegWithScaling(data, 1.25, 'Latency', 's', ERROR_MESSAGES.dis_double);
        break;
      case 0x23:
        this.handleRegWithScaling(data, 1.25, 'Window', 's', ERROR_MESSAGES.dis_double);
        break;
      case 0x24:
      case 0x25:
      case 0x28:
        this.handleRegWithScaling(data, 62.5, 'Threshold', 'g', ERROR_MESSAGES.undesirable);
        break;
      case 0x26:
        this.handleRegWithScaling(data, 1000, 'Time', 's', ERROR_MESSAGES.interrupt);
        break;
      case 0x27:
        this.interpretBits(data, [
          bit('ACT', 'acdc'),
          bit('ACT_X', 'enable'),
          bit('ACT_Y', 'enable'),
          bit('ACT_Z', 'enable'),
          bit('INACT', 'acdc'),
          bit('INACT_X', 'enable'),
          bit('INACT_Y', 'enable'),
          bit('INACT_Z', 'enable'),
        ]);
        break;
      case 0x29:
        this.handleRegWithScaling(data, 5, 'Time', 's', ERROR_MESSAGES.undesirable);
        break;
      case 0x2a:
        this.interpretBits(data, [
          bit('', 'unused'),
          bit('', 'unused'),
          bit('', 'unused'),
          bit('', 'unused'),
          bit('', 'other', { 0: ['Unsuppressed', 'Unsuppr', 'Uns'], 1: ['Suppressed', 'Suppr', 'S'] }),
          bit('TAP_X', 'enable'),
          bit('TAP_Y', 'enable'),
          bit('TAP_Z', 'enable'),
        ]);
        break;
      case 0x2b:
        this.interpretBits(data, [
          bit('', 'unused'),
          bit('ACT_X', 'source'),
          bit('ACT_Y', 'source'),
          bit('ACT_Z', 'source'),
          bit('', 'other', { 0: ['Not asleep', 'Not asl', '!Asl'], 1: ['Asleep', 'Asl'] }),
          bit('TAP_X', 'source'),
          bit('TAP_Y', 'source'),
          bit('TAP_Z', 'source'),
        ]);
        break;
      case 0x2c:
        this.handleReg0x2c(data);
        break;
      case 0x2d:
        this.handleReg0x2d(data);
        break;
      case 0x2e:
        this.interpretBits(data, [
          bit('DATA_READY', 'enable'),
          bit('SINGLE_TAP', 'enable'),
          bit('DOUBLE_TAP', 'enable'),
          bit('Activity', 'enable'),
          bit('Inactivity', 'enable'),
          bit('FREE_FALL', 'enable'),
          bit('Watermark', 'enable'),
          bit('Overrun', 'enable'),
        ]);
        break;
      case 0x2f:
        this.interpretBits(data, [
          bit('DATA_READY', 'interrupt'),
          bit('SINGLE_TAP', 'interrupt'),
          bit('DOUBLE_TAP', 'interrupt'),
          bit('Activity', 'interrupt'),
          bit('Inactivity', 'interrupt'),
          bit('FREE_FALL', 'interrupt'),
          bit('Watermark', 'interrupt'),
          bit('Overrun', 'interrupt'),
        ]);
        break;
      case 0x30:
        this.interpretBits(data, [
          bit('DATA_READY', 'source'),
          bit('SINGLE_TAP', 'source'),
          bit('DOUBLE_TAP', 'source'),
          bit('Activity', 'source'),
          bit('Inactivity', 'source'),
          bit('FREE_FALL', 'source'),
          bit('Watermark', 'source'),
          bit('Overrun', 'source'),
        ]);
        break;
      case 0x31:
        this.handleReg0x31(data);
        break;
      case 0x32:
      case 0x34:
      case 0x36:
        this.storedData = data;
        this.putCurrent(ANN.REG_DATA, [String(data)]);
        break;
      case 0x33:
        this.handleAxis(data, 'X');
        break;
      case 0x35:
        this.handleAxis(data, 'Y');
        break;
      case 0x37:
        this.handleAxis(data, 'Z');
        break;
      case 0x38: {
        const values = this.interpretBits(data, [
            null,
            null,
            bit('', 'other', { 0: ['Trig-INT1', 'INT1'], 1: ['Trig-INT2', 'INT2'] }),
          ]),
          fifo = this.decimalNumber(values, 6, 7),
          samples = this.decimalNumber(values, 0, 4);
        this.putBitRange(ANN.REG_DATA, [FIFO_MODES[fifo]!], 7, 6);
        this.putBitRange(ANN.REG_DATA, [`Samples: ${samples}`, String(samples)], 4, 0);
        break;
      }
      case 0x39: {
        const values = this.interpretBits(data, [
            bit('', 'other', { 0: ['Not triggered', 'Not trigg'], 1: ['Triggered', 'Trigg'] }),
            bit('', 'unused'),
          ]),
          entries = this.decimalNumber(values, 0, 5);
        this.putBitRange(ANN.REG_DATA, [`Entries: ${entries}`, String(entries)], 5, 0);
        break;
      }
    }
  }

  private consumeByte(mosi: WireByte | null, miso: WireByte | null): void {
    const byte = mosi ?? miso;
    if (!byte) return;
    this.currentSs = byte.ss;
    this.currentEs = byte.es;
    if (this.state === 'address') {
      if (mosi) this.commitAddress(mosi);
      return;
    }
    if (this.state !== 'data') return;
    const source = this.operation === READ ? miso : mosi;
    if (!source) return;

    this.pending.push(...byteBits(source));
    if (this.dataStart === null) {
      this.dataStart = this.pending[0]!.ss;
      this.samplesPerBit = this.pending[0]!.es - this.pending[0]!.ss;
    }
    if (this.pending.length < 8) return;

    const bits = this.pending.splice(0, 8),
      last = bits[7]!;
    let value = 0;
    for (let index = 0; index < 8; index++) value |= bits[index]!.value << (7 - index);
    if (this.address < 0x00 || this.address > 0x39) {
      this.pending = [];
      return;
    }
    if (this.address === 0x32 || this.address === 0x34 || this.address === 0x36) this.startIndex = this.dataStart!;
    if (this.address < 0x1d) {
      this.put(this.dataStart!, last.es, this.outAnn, [ANN.REG_ADDRESS, [String(this.address)]]);
      this.put(this.dataStart!, last.es, this.outAnn, [ANN.REG_DATA, [String(value)]]);
    } else {
      this.put(this.dataStart!, last.es, this.outAnn, [ANN.REG_ADDRESS, REGISTERS[this.address]!]);
      this.handleRegister(this.address, value);
    }
    this.pending = [];
    this.address++;
    this.dataStart = null;
    if (!this.multiple) this.state = 'address';
  }

  private split(ss: bigint, es: bigint, mosi: number | null, miso: number | null): [WireByte[], WireByte[]] {
    const count = Math.max(wordWidth(mosi), wordWidth(miso)),
      span = es - ss,
      mosiValue = mosi ?? 0,
      misoValue = miso ?? 0,
      mosiBytes: WireByte[] = [],
      misoBytes: WireByte[] = [];
    for (let index = 0; index < count; index++) {
      const dataSs = ss + (span * BigInt(index)) / BigInt(count),
        dataEs = ss + (span * BigInt(index + 1)) / BigInt(count),
        shift = 8 * (count - index - 1);
      mosiBytes.push({
        value: mosi === null ? null : Math.floor(mosiValue / 2 ** shift) & 0xff,
        ss: dataSs,
        es: dataEs,
      });
      misoBytes.push({
        value: miso === null ? null : Math.floor(misoValue / 2 ** shift) & 0xff,
        ss: dataSs,
        es: dataEs,
      });
    }
    return [mosiBytes, misoBytes];
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    if (!Array.isArray(data)) return;
    if (data[0] === 'WARNING') return;
    if (data[0] !== 'WORD') return;
    const mosi = typeof data[1] === 'number' ? data[1] : null,
      miso = typeof data[2] === 'number' ? data[2] : null,
      cs = typeof data[3] === 'boolean' ? data[3] : null;
    if (mosi === null && miso === null) return;

    if (cs === false) {
      this.endTransaction();
      this.previousCs = false;
      this.lastWordEnd = es;
      this.lastWordSpan = es > ss ? es - ss : 0n;
      return;
    }
    if (cs === true && this.previousCs === false) this.endTransaction();
    if (this.state !== 'idle' && this.lastWordEnd !== null && ss - this.lastWordEnd > this.lastWordSpan)
      this.endTransaction();
    if (this.state === 'idle') this.beginTransaction();

    const [mosiBytes, misoBytes] = this.split(ss, es, mosi, miso);
    for (let index = 0; index < mosiBytes.length; index++)
      this.consumeByte(mosiBytes[index] ?? null, misoBytes[index] ?? null);

    this.previousCs = cs;
    this.lastWordEnd = es;
    this.lastWordSpan = es > ss ? es - ss : 0n;
  }
}

export default Adxl345Decoder;
