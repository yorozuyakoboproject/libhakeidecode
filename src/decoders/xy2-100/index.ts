import { Decoder, OUTPUT_ANN } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

interface XyBit {
  readonly ss: bigint;
  readonly es: bigint;
  readonly value: number;
}

const ANN = Object.freeze({
  BIT: 0,
  STATUS_BIT: 1,
  TYPE: 2,
  COMMAND: 3,
  PARAMETER: 4,
  PARITY: 5,
  POSITION: 6,
  STATUS: 7,
  WARNING: 8,
});

export class Xy2100Decoder extends Decoder {
  static descriptor = descriptor;
  private outAnn = -1;
  private bits: XyBit[] = [];
  private statusBits: XyBit[] = [];
  private skipStatusBit = true;

  override reset(): void {
    this.resetData();
    this.resetStatus();
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private resetData(): void {
    this.bits = [];
  }

  private resetStatus(): void {
    this.statusBits = [];
    this.skipStatusBit = true;
  }

  private warning(ss: bigint, es: bigint, texts: readonly string[]): void {
    this.put(ss, es, this.outAnn, [ANN.WARNING, texts]);
  }

  private processBit(sync: number, bitSs: bigint, bitEs: bigint, value: number): void {
    this.put(bitSs, bitEs, this.outAnn, [ANN.BIT, [String(value)]]);
    this.bits.push({ ss: bitSs, es: bitEs, value });
    if (sync !== 0) return;
    if (this.bits.length < 20) {
      this.warning(this.bits[0]!.ss, bitEs, ['Not enough data bits']);
      this.resetData();
      this.resetStatus();
      return;
    }

    let parity = 0;
    for (let index = 0; index < 19; index++) parity ^= this.bits[index]!.value;
    const parityValue = this.bits[19]!.value;
    const even = parityValue === parity;
    const type1 = this.bits[0]!.value;
    const type3 = (this.bits[0]!.value << 2) | (this.bits[1]!.value << 1) | this.bits[2]!.value;
    const first = this.bits[0]!;
    const parityBit = this.bits[19]!;
    let frameType: '16bit' | '18bit' | 'command' | null = null;
    let typeSs = first.ss;
    let typeEs = this.bits[2]!.es;
    let parityTexts: readonly string[] = ['X', 'Unknown'];

    if (type1 === 1 && !even) {
      frameType = '18bit';
      typeEs = first.es;
      this.warning(first.ss, bitEs, [
        'Careful: 18-bit position frames with wrong parity and command frames with wrong parity cannot be identified',
      ]);
    } else if (type3 === 1) {
      frameType = '16bit';
      parityTexts = even ? ['OK'] : ['NOK'];
      if (!even) this.warning(first.ss, bitEs, ['Parity error', 'PE']);
    } else if (type3 === 7 && even) {
      frameType = 'command';
      this.warning(first.ss, bitEs, [
        'Careful: 18-bit position frames with wrong parity and command frames with wrong parity cannot be identified',
      ]);
    } else {
      this.warning(first.ss, bitEs, ['Error', 'Unknown command or parity error']);
      this.resetData();
      this.resetStatus();
      return;
    }

    if (frameType === '16bit')
      this.put(typeSs, typeEs, this.outAnn, [ANN.TYPE, ['16 bit Position Frame', '16 bit Pos', 'Pos', 'P']]);
    else if (frameType === '18bit')
      this.put(typeSs, typeEs, this.outAnn, [ANN.TYPE, ['18 bit Position Frame', '18 bit Pos', 'Pos', 'P']]);
    else this.put(typeSs, typeEs, this.outAnn, [ANN.TYPE, ['Command Frame', 'Command', 'C']]);
    this.put(parityBit.ss, parityBit.es, this.outAnn, [ANN.PARITY, parityTexts]);

    if (frameType === '16bit' || frameType === '18bit') {
      let position = 0;
      if (frameType === '16bit') {
        for (let index = 0; index < 16; index++) position |= this.bits[index + 3]!.value << (15 - index);
        if (position >= 32768) position -= 65536;
      } else {
        for (let index = 0; index < 16; index++) position |= this.bits[index + 3]!.value << (17 - index);
        if (position >= 131072) position -= 262144;
      }
      this.put(typeEs, parityBit.ss, this.outAnn, [ANN.POSITION, [String(position)]]);
    } else {
      let command = 0;
      for (let index = 0; index < 8; index++) command |= this.bits[index + 3]!.value << (7 - index);
      const commandEs = this.bits[10]!.es;
      const commandText = command.toString(16).toUpperCase();
      this.put(typeEs, commandEs, this.outAnn, [
        ANN.COMMAND,
        [`Command 0x${commandText}`, `Cmd 0x${commandText}`, `0x${commandText}`],
      ]);
      let parameter = 0;
      for (let index = 0; index < 8; index++) parameter |= this.bits[index + 11]!.value << (7 - index);
      const parameterText = parameter.toString(16).toUpperCase();
      this.put(commandEs, parityBit.ss, this.outAnn, [
        ANN.PARAMETER,
        [`Parameter 0x${parameterText} / ${parameter}`, `0x${parameterText} / ${parameter}`, `0x${parameterText}`],
      ]);
    }
    this.resetData();
  }

  private processStatusBit(sync: number, bitSs: bigint, bitEs: bigint, value: number): void {
    if (this.skipStatusBit) {
      this.skipStatusBit = false;
      return;
    }
    this.put(bitSs, bitEs, this.outAnn, [ANN.STATUS_BIT, [String(value)]]);
    this.statusBits.push({ ss: bitSs, es: bitEs, value });
    if (sync !== 0 || this.statusBits.length !== 19) return;
    let status = 0;
    for (let index = 0; index < 19; index++) status |= this.statusBits[index]!.value << (18 - index);
    const text = status.toString(16).toUpperCase();
    this.put(this.statusBits[0]!.ss, this.statusBits[18]!.es, this.outAnn, [
      ANN.STATUS,
      [`Status 0x${text}`, `0x${text}`],
    ]);
    this.resetStatus();
  }

  *decode(): LogicGenerator {
    const hasStatus = this.hasChannel('status');
    let bitSs: bigint | null = null;
    let bitValue = 0;
    let syncValue = 0;
    let statusSs: bigint | null = null;
    let statusValue = 0;
    while (true) {
      const pins = yield this.wait({ clk: 'e' });
      const clk = Number(pins[0]);
      if (clk === 1) {
        statusValue = Number(pins[3] ?? 0);
        if (bitSs !== null) this.processBit(syncValue, bitSs, this.samplenum, bitValue);
        bitSs = this.samplenum;
      } else {
        bitValue = Number(pins[2]);
        syncValue = Number(pins[1]);
        if (statusSs !== null && hasStatus) this.processStatusBit(syncValue, statusSs, this.samplenum, statusValue);
        statusSs = this.samplenum;
      }
    }
  }
}

export default Xy2100Decoder;
