import { descriptor } from './descriptor.js';
import {
  Decoder,
  generatorPlugin,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_PROTOCOL,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type { DecoderContext, DecoderPlugin, LogicGenerator } from '../../libhakeidecode/index.js';
import type { DecodeFrame } from '../definition.js';

export interface SPIOptions {
  cs_polarity: 'active-low' | 'active-high';
  cpol: number;
  cpha: number;
  bitorder: 'msb-first' | 'lsb-first';
  wordsize: number;
}
export interface SPIFrame extends DecodeFrame {
  mosi: number | null;
  miso: number | null;
  cs: boolean | null;
  wordIndex: number;
}
export type SPIProtocolPacket =
  | ['WORD', mosi: number | null, miso: number | null, cs: boolean | null, wordIndex: number]
  | ['WARNING', message: string];
export const SPI_ANN = Object.freeze({ WORD: 0, WARNING: 1 });
const CLK = 0,
  MISO = 1,
  MOSI = 2,
  CS = 3;

export class SPIDecoder extends Decoder<SPIOptions> {
  static descriptor = descriptor;
  samplerate: number | null = null;
  private outProtocol = -1;
  private outBinary = -1;
  private outAnn = -1;
  private hasMiso = false;
  private hasMosi = false;
  private hasCs = false;
  private csActive = true;
  private bits = 0;
  private mosi = 0;
  private miso = 0;
  private firstSample: bigint | null = null;
  private wordIndex = 0;

  constructor(options: Partial<SPIOptions> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.samplerate = null;
    this.hasMiso = false;
    this.hasMosi = false;
    this.hasCs = false;
    this.csActive = true;
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.firstSample = null;
    this.wordIndex = 0;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'spi');
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outAnn = this.register(OUTPUT_ANN);
    this.hasMiso = this.hasChannel('miso');
    this.hasMosi = this.hasChannel('mosi');
    this.hasCs = this.hasChannel('cs');
    if (!this.hasMiso && !this.hasMosi) throw new Error('SPI requires MISO or MOSI.');
    if (!Number.isInteger(this.options.wordsize) || this.options.wordsize < 1 || this.options.wordsize > 32)
      throw new Error('SPI word size must be 1..32.');
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private warning(message: string): void {
    this.put(this.samplenum, this.samplenum, this.outAnn, [SPI_ANN.WARNING, [message]]);
    this.put(this.samplenum, this.samplenum, this.outProtocol, ['WARNING', message]);
  }

  private discardPartial(reason: string): void {
    if (!this.bits) return;
    this.warning(reason + ': ' + this.bits + ' bit(s) discarded');
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.firstSample = null;
  }

  private binary(value: number): Uint8Array {
    const width = Math.ceil(this.options.wordsize / 8);
    return Uint8Array.from({ length: width }, (_, index) => Math.floor(value / 2 ** (8 * (width - index - 1))) & 0xff);
  }

  private emitWord(): void {
    const mosi = this.hasMosi ? this.mosi : null,
      miso = this.hasMiso ? this.miso : null,
      cs = this.hasCs ? this.csActive : null,
      ss = this.firstSample ?? this.samplenum,
      digits = Math.ceil(this.options.wordsize / 4),
      texts = [
        'Word',
        String(this.wordIndex),
        ...(mosi === null ? [] : ['MOSI=0x' + mosi.toString(16).padStart(digits, '0').toUpperCase()]),
        ...(miso === null ? [] : ['MISO=0x' + miso.toString(16).padStart(digits, '0').toUpperCase()]),
      ];
    this.put(ss, this.samplenum, this.outAnn, [SPI_ANN.WORD, texts, mosi ?? miso ?? 0]);
    this.put(ss, this.samplenum, this.outProtocol, ['WORD', mosi, miso, cs, this.wordIndex]);
    if (mosi !== null) this.put(ss, this.samplenum, this.outBinary, [0, this.binary(mosi)]);
    if (miso !== null) this.put(ss, this.samplenum, this.outBinary, [1, this.binary(miso)]);
    this.wordIndex++;
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.firstSample = null;
  }

  private sample(mosi: number, miso: number): void {
    if (!this.bits) this.firstSample = this.samplenum;
    if (this.options.bitorder === 'msb-first') {
      this.mosi = ((this.mosi << 1) | mosi) >>> 0;
      this.miso = ((this.miso << 1) | miso) >>> 0;
    } else {
      this.mosi += mosi * 2 ** this.bits;
      this.miso += miso * 2 ** this.bits;
    }
    this.bits++;
    if (this.bits === this.options.wordsize) this.emitWord();
  }

  *decode(): LogicGenerator {
    if (!this.samplerate) throw new Error('Cannot decode without samplerate.');
    let pins = yield this.wait();
    let previousClk = Number(pins[CLK]),
      previousCs = this.hasCs ? Number(pins[CS]) : null;
    if (this.hasCs) this.csActive = previousCs === (this.options.cs_polarity === 'active-low' ? 0 : 1);
    const sampleLevel = this.options.cpol === this.options.cpha ? 1 : 0;
    while (true) {
      const conditions: Record<string, 'e'>[] = [{ clk: 'e' }];
      if (this.hasCs) conditions.push({ cs: 'e' });
      pins = yield this.wait(conditions);
      const clk = Number(pins[CLK]),
        cs = this.hasCs ? Number(pins[CS]) : null;
      if (this.hasCs && cs !== previousCs) {
        const active = cs === (this.options.cs_polarity === 'active-low' ? 0 : 1);
        if (!active && this.csActive) this.discardPartial('Chip select deasserted');
        this.csActive = active;
      }
      if (clk === sampleLevel && previousClk !== clk && this.csActive)
        this.sample(this.hasMosi ? Number(pins[MOSI]) : 0, this.hasMiso ? Number(pins[MISO]) : 0);
      previousClk = clk;
      previousCs = cs;
    }
  }

  onEof(): void {
    if (this.bits) this.discardPartial('End of capture');
  }
}

export const spiPlugin: DecoderPlugin<any, any> = {
  decoder: SPIDecoder,
  descriptor,
  createEngine: (context) => generatorPlugin(SPIDecoder).createEngine(context),
};

export default SPIDecoder;
