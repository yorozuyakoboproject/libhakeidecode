import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext } from '../../libhakeidecode/index.js';
import type { SPIProtocolPacket } from '../spi/index.js';
import { descriptor } from './descriptor.js';
import { commandName } from './commands.js';

const ANN = Object.freeze({ BIT: 133, BIT_WARNING: 134, R1: 128, R1B: 129, R2: 130, R3: 131, R7: 132 });

interface BitSpan {
  readonly value: number;
  readonly ss: bigint;
  readonly es: bigint;
}

interface BytePair {
  readonly mosi: number;
  readonly miso: number;
  readonly ss: bigint;
  readonly es: bigint;
}

const SUPPORTED = new Set([0, 1, 9, 10, 16, 17, 24, 41, 49, 55, 59]);

export class SdcardSpiDecoder extends Decoder {
  static descriptor = descriptor;

  private outAnn = -1;
  private state = 'IDLE';
  private ss = 0n;
  private es = 0n;
  private ssBit = 0n;
  private esBit = 0n;
  private ssCmd = 0n;
  private esCmd = 0n;
  private ssBusy = 0n;
  private esBusy = 0n;
  private ssData = 0n;
  private esData = 0n;
  private ssCrc = 0n;
  private esCrc = 0n;
  private cmdToken: number[] = [];
  private cmdTokenBits: BitSpan[][] = [];
  private mosiBits: BitSpan[] = [];
  private misoBits: BitSpan[] = [];
  private isAcmd = false;
  private blockLen = 0;
  private readBuf: number[] = [];
  private cmdStr = '';
  private isCmd24 = false;
  private cmd24Start = false;
  private isCmd17 = false;
  private cmd17Start = false;
  private busyFirstByte = false;
  private mosi = 0;
  private miso = 0;

  constructor() {
    super();
    this.reset();
  }

  override reset(): void {
    this.state = 'IDLE';
    this.ss = this.es = 0n;
    this.ssBit = this.esBit = 0n;
    this.ssCmd = this.esCmd = 0n;
    this.ssBusy = this.esBusy = 0n;
    this.ssData = this.esData = 0n;
    this.ssCrc = this.esCrc = 0n;
    this.cmdToken = [];
    this.cmdTokenBits = [];
    this.mosiBits = [];
    this.misoBits = [];
    this.isAcmd = false;
    this.blockLen = 0;
    this.readBuf = [];
    this.cmdStr = '';
    this.isCmd24 = false;
    this.cmd24Start = false;
    this.isCmd17 = false;
    this.cmd17Start = false;
    this.busyFirstByte = false;
    this.mosi = 0;
    this.miso = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private putAt(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putx(classIndex: number, texts: readonly string[]): void {
    this.putAt(this.ssCmd, this.esCmd, classIndex, texts);
  }

  private putc(classIndex: number, description: string): void {
    this.putx(classIndex, [`${this.cmdStr}: ${description}`]);
  }

  private putb(classIndex: number, texts: readonly string[]): void {
    this.putAt(this.ssBit, this.esBit, classIndex, texts);
  }

  private classForCommand(index: number, application: boolean): number {
    return application ? 64 + index : index;
  }

  private splitBits(ss: bigint, es: bigint, value: number): BitSpan[] {
    const span = es - ss;
    return Array.from({ length: 8 }, (_, index) => ({
      value: (value >>> (7 - index)) & 1,
      ss: ss + (span * BigInt(index)) / 8n,
      es: ss + (span * BigInt(index + 1)) / 8n,
    }));
  }

  private handleCommandToken(): void {
    if (!this.cmdToken.length) this.ssCmd = this.ss;
    this.cmdToken.push(this.mosi);
    this.cmdTokenBits.push(this.mosiBits);
    if (this.cmdToken.length < 6) return;
    this.esCmd = this.es;
    const token = this.cmdToken,
      application = this.isAcmd,
      prefix = application ? 'ACMD' : 'CMD',
      bit = (byte: number, position: number): BitSpan => this.cmdTokenBits[5 - byte]![7 - position]!;

    let span = bit(5, 7);
    this.ssBit = span.ss;
    this.esBit = span.es;
    if (span.value === 0) this.putb(ANN.BIT, ['Start bit: 0']);
    else this.putb(ANN.BIT_WARNING, ['Start bit: 1 (Warning: Must be 0!)']);

    span = bit(5, 6);
    this.ssBit = span.ss;
    this.esBit = span.es;
    if (span.value === 1) this.putb(ANN.BIT, ['Transmitter bit: 1']);
    else this.putb(ANN.BIT_WARNING, ['Transmitter bit: 0 (Warning: Must be 1!)']);

    const index = token[0]! & 0x3f,
      name = commandName(index, application);
    this.ssBit = bit(5, 5).ss;
    this.esBit = bit(5, 0).es;
    this.putb(ANN.BIT, [`Command: ${prefix}${index} (${name})`]);

    const arg = ((token[1]! << 24) | (token[2]! << 16) | (token[3]! << 8) | token[4]!) >>> 0;
    this.ssBit = bit(4, 7).ss;
    this.esBit = bit(1, 0).es;
    this.putb(ANN.BIT, [`Argument: 0x${arg.toString(16).padStart(4, '0')}`]);

    this.ssBit = bit(0, 7).ss;
    this.esBit = bit(0, 1).es;
    this.putb(ANN.BIT, [`CRC7: 0x${(token[5]! >>> 1).toString(16)}`]);

    span = bit(0, 0);
    this.ssBit = span.ss;
    this.esBit = span.es;
    if (span.value === 1) this.putb(ANN.BIT, ['End bit: 1']);
    else this.putb(ANN.BIT_WARNING, ['End bit: 0 (Warning: Must be 1!)']);

    this.cmdStr = `${prefix}${index} (${name})`;
    if (SUPPORTED.has(index)) this.state = `HANDLE CMD${index}`;
    else {
      this.state = 'HANDLE CMD999';
      this.putx(this.classForCommand(index, application), [
        `${prefix}${index}: ${token.map((value) => value.toString(16).padStart(2, '0')).join(' ')}`,
      ]);
    }
  }

  private handleCmd0(): void {
    this.putc(0, 'Reset the SD card');
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd1(): void {
    this.putc(1, 'Send HCS info and activate the card init process');
    const hcs = (this.cmdToken[4]! >>> 6) & 1;
    const span = this.cmdTokenBits[1]![1]!;
    this.ssBit = span.ss;
    this.esBit = span.es;
    this.putb(ANN.BIT, [`HCS: ${hcs}`]);
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd9(): void {
    if (!this.readBuf.length) this.ssCmd = this.ss;
    this.readBuf.push(this.miso);
    if (this.readBuf.length === 1) this.putc(9, 'Ask card to send its card specific data (CSD)');
    if (this.readBuf.length < 20) return;
    this.esCmd = this.es;
    const data = this.readBuf.slice(4);
    this.putx(9, [`CSD: ${data.map((value) => value.toString(16).padStart(2, '0')).join(' ')}`]);
    this.readBuf = [];
    this.state = 'IDLE';
  }

  private handleCmd10(): void {
    this.readBuf.push(this.miso);
    if (this.readBuf.length === 1) this.putc(10, 'Ask card to send its card identification (CID)');
    if (this.readBuf.length < 16) return;
    this.esCmd = this.es;
    this.putx(10, [`CID: ${this.readBuf.map((value) => value.toString(16).padStart(2, '0')).join(' ')}`]);
    this.readBuf = [];
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd16(): void {
    this.blockLen = this.argument();
    this.putc(16, `Set the block length to ${this.blockLen} bytes`);
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd17(): void {
    this.putc(17, `Read a block from address 0x${this.argument().toString(16).padStart(4, '0')}`);
    this.isCmd17 = true;
    this.cmd17Start = false;
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd24(): void {
    this.putc(24, `Write a block to address 0x${this.argument().toString(16).padStart(4, '0')}`);
    this.isCmd24 = true;
    this.cmd24Start = false;
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd55(): void {
    this.putc(55, 'Next command is an application-specific command');
    this.isAcmd = true;
    this.state = 'GET RESPONSE R1';
  }

  private handleCmd59(): void {
    const enabled = (this.argument() & 1) !== 0;
    this.putc(59, `Turn the SD card CRC option ${enabled ? 'on' : 'off'}`);
    this.state = 'GET RESPONSE R1';
  }

  private handleAcmd41(): void {
    this.putc(this.classForCommand(41, true), 'Send HCS info and activate the card init process');
    this.state = 'GET RESPONSE R1';
  }

  private handleGeneric(): void {
    this.state = 'GET RESPONSE R1';
  }

  private argument(): number {
    return ((this.cmdToken[1]! << 24) | (this.cmdToken[2]! << 16) | (this.cmdToken[3]! << 8) | this.cmdToken[4]!) >>> 0;
  }

  private runCommandHandler(): void {
    const match = /^HANDLE (?:A)?CMD(\d+)$/.exec(this.state),
      index = Number(match?.[1]);
    if (this.isAcmd) {
      if (index === 41) this.handleAcmd41();
      else this.handleGeneric();
    } else if (index === 0) this.handleCmd0();
    else if (index === 1) this.handleCmd1();
    else if (index === 9) this.handleCmd9();
    else if (index === 10) this.handleCmd10();
    else if (index === 16) this.handleCmd16();
    else if (index === 17) this.handleCmd17();
    else if (index === 24) this.handleCmd24();
    else if (index === 55) this.handleCmd55();
    else if (index === 59) this.handleCmd59();
    else this.handleGeneric();
    this.cmdToken = [];
    this.cmdTokenBits = [];
    if (this.isAcmd && index !== 55) this.isAcmd = false;
  }

  private putResponseBit(index: number, texts: readonly string[]): void {
    const span = this.misoBits[7 - index]!;
    this.ssBit = span.ss;
    this.esBit = span.es;
    this.putb(ANN.BIT, texts);
  }

  private handleResponseR1(value: number): void {
    this.ssCmd = this.misoBits[0]!.ss;
    this.esCmd = this.misoBits[7]!.es;
    this.putx(ANN.R1, [`R1: 0x${value.toString(16).padStart(2, '0')}`]);
    this.putResponseBit(0, [`Card is ${value & 1 ? '' : 'not '}in idle state`]);
    this.putResponseBit(1, [`Erase sequence ${value & 2 ? '' : 'not '}cleared`]);
    this.putResponseBit(2, [`${value & 4 ? 'I' : 'No i'}llegal command detected`]);
    this.putResponseBit(3, [`CRC check of last command ${value & 8 ? 'failed' : 'was successful'}`]);
    this.putResponseBit(4, [`${value & 0x10 ? 'E' : 'No e'}rror in the sequence of erase commands`]);
    this.putResponseBit(5, [`${value & 0x20 ? 'M' : 'No m'}isaligned address used in command`]);
    this.putResponseBit(6, [`Command argument ${value & 0x40 ? '' : 'not '}outside allowed range`]);
    this.putResponseBit(7, ['Bit 7 (always 0)']);
    if (this.isCmd17) this.state = 'HANDLE DATA BLOCK CMD17';
    else if (this.isCmd24) this.state = 'HANDLE DATA BLOCK CMD24';
    else this.state = 'IDLE';
  }

  private handleResponseR1b(value: number): void {
    this.putx(ANN.R1B, [`R1b: 0x${value.toString(16).padStart(2, '0')}`]);
    this.state = 'IDLE';
  }

  private handleResponseR2(value: number): void {
    this.putx(ANN.R2, [`R2: 0x${value.toString(16).padStart(2, '0')}`]);
    this.state = 'IDLE';
  }

  private handleResponseR3(value: number): void {
    this.putx(ANN.R3, [`R3 OCR: 0x${value.toString(16).padStart(2, '0')}`]);
    this.state = 'IDLE';
  }

  private handleResponseR7(value: number): void {
    this.putx(ANN.R7, [`R7: 0x${value.toString(16).padStart(2, '0')}`]);
    this.state = 'IDLE';
  }

  private handleResponse(value: number): void {
    const kind = this.state.slice('GET RESPONSE '.length);
    this.state = 'IDLE';
    if (kind === 'R1') this.handleResponseR1(value);
    else if (kind === 'R1B') this.handleResponseR1b(value);
    else if (kind === 'R2') this.handleResponseR2(value);
    else if (kind === 'R3') this.handleResponseR3(value);
    else if (kind === 'R7') this.handleResponseR7(value);
  }

  private handleDataCmd17(value: number): void {
    if (this.cmd17Start) {
      if (!this.readBuf.length) {
        this.ssData = this.ss;
        if (!this.blockLen) this.blockLen = 512;
      }
      this.readBuf.push(value);
      if (this.readBuf.length === this.blockLen) {
        this.esData = this.es;
        this.putAt(this.ssData, this.esData, 17, [`Block data: ${this.readBuf.join(' ')}`]);
      } else if (this.readBuf.length === this.blockLen + 1) this.ssCrc = this.ss;
      else if (this.readBuf.length === this.blockLen + 2) {
        this.esCrc = this.es;
        this.putAt(this.ssCrc, this.esCrc, 17, ['CRC']);
        this.readBuf = [];
        this.isCmd17 = false;
        this.cmd17Start = false;
        this.state = 'IDLE';
      }
    } else if (value === 0xfe) {
      this.putAt(this.ss, this.es, 17, ['Start Block']);
      this.cmd17Start = true;
    }
  }

  private handleDataCmd24(value: number): void {
    if (this.cmd24Start) {
      if (!this.readBuf.length) {
        this.ssData = this.ss;
        if (!this.blockLen) this.blockLen = 512;
      }
      this.readBuf.push(value);
      if (this.readBuf.length >= this.blockLen) {
        this.esData = this.es;
        this.putAt(this.ssData, this.esData, 24, [`Block data: ${this.readBuf.join(' ')}`]);
        this.readBuf = [];
        this.state = 'DATA RESPONSE';
      }
    } else if (value === 0xfe) {
      this.putAt(this.ss, this.es, 24, ['Start Block']);
      this.cmd24Start = true;
    }
  }

  private handleDataResponse(value: number): void {
    value &= 0x1f;
    if ((value & 0x11) !== 0x01) return;
    const bits = this.misoBits;
    this.putAt(bits[0]!.ss, bits[2]!.es, ANN.BIT, ["Don't care"]);
    this.putAt(bits[3]!.ss, bits[3]!.es, ANN.BIT, ['Always 0']);
    if (value === 0x05) this.putAt(bits[4]!.ss, bits[6]!.es, ANN.BIT, ['Data accepted']);
    else if (value === 0x0b) this.putAt(bits[4]!.ss, bits[6]!.es, ANN.BIT, ['Data rejected (CRC error)']);
    else if (value === 0x0d) this.putAt(bits[4]!.ss, bits[6]!.es, ANN.BIT, ['Data rejected (write error)']);
    this.putAt(bits[7]!.ss, bits[7]!.es, ANN.BIT, ['Always 1']);
    if (this.isCmd24) this.putAt(this.ss, this.es, 24, ['Data Response']);
    if (this.isCmd24) {
      this.state = 'WAIT WHILE CARD BUSY';
      this.busyFirstByte = true;
    } else this.state = 'IDLE';
  }

  private waitWhileBusy(value: number): void {
    if (value !== 0) {
      if (this.isCmd24 && !this.busyFirstByte) this.putAt(this.ssBusy, this.esBusy, 24, ['Card is busy']);
      this.isCmd24 = false;
      this.cmd24Start = false;
      this.state = 'IDLE';
    } else if (this.busyFirstByte) {
      this.ssBusy = this.ss;
      this.esBusy = this.es;
      this.busyFirstByte = false;
    } else {
      this.esBusy = this.es;
    }
  }

  private processByte(pair: BytePair): void {
    this.ss = pair.ss;
    this.es = pair.es;
    this.mosi = pair.mosi;
    this.miso = pair.miso;
    this.mosiBits = this.splitBits(pair.ss, pair.es, pair.mosi);
    this.misoBits = this.splitBits(pair.ss, pair.es, pair.miso);

    if (this.state === 'IDLE') {
      if (this.mosi === 0xff) return;
      this.state = 'GET COMMAND TOKEN';
      this.handleCommandToken();
    } else if (this.state === 'GET COMMAND TOKEN') {
      this.handleCommandToken();
    } else if (this.state.startsWith('HANDLE CMD')) {
      this.runCommandHandler();
    } else if (this.state.startsWith('GET RESPONSE')) {
      if (this.miso === 0xff) return;
      this.handleResponse(this.miso);
    } else if (this.state === 'HANDLE DATA BLOCK CMD17') {
      this.handleDataCmd17(this.miso);
    } else if (this.state === 'HANDLE DATA BLOCK CMD24') {
      this.handleDataCmd24(this.mosi);
    } else if (this.state === 'DATA RESPONSE') {
      this.handleDataResponse(this.miso);
    } else if (this.state === 'WAIT WHILE CARD BUSY') {
      this.waitWhileBusy(this.miso);
    }
  }

  private splitWord(ss: bigint, es: bigint, mosi: number | null, miso: number | null): BytePair[] {
    const width = (value: number | null): number =>
      value === null || value === 0 ? 1 : Math.ceil((32 - Math.clz32(value >>> 0)) / 8);
    const count = Math.max(width(mosi), width(miso)),
      span = es - ss;
    return Array.from({ length: count }, (_, index) => {
      const shift = 8 * (count - index - 1);
      return {
        mosi: typeof mosi === 'number' ? Math.floor(mosi / 2 ** shift) & 0xff : 0,
        miso: typeof miso === 'number' ? Math.floor(miso / 2 ** shift) & 0xff : 0,
        ss: ss + (span * BigInt(index)) / BigInt(count),
        es: ss + (span * BigInt(index + 1)) / BigInt(count),
      };
    });
  }

  decode(ss: bigint, es: bigint, data: unknown): void {
    const packet = data as SPIProtocolPacket;
    if (!Array.isArray(packet)) return;
    if (packet[0] === 'WARNING') return;
    if (packet[0] !== 'WORD') return;
    const mosi = typeof packet[1] === 'number' ? packet[1] : null,
      miso = typeof packet[2] === 'number' ? packet[2] : null;
    for (const pair of this.splitWord(ss, es, mosi, miso)) this.processByte(pair);
  }
}

export default SdcardSpiDecoder;
