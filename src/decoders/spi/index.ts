import { descriptor } from './descriptor.js';
import {
  Decoder,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_PROTOCOL,
  OutputStreams,
  SRD_CONF_SAMPLERATE,
} from '../../libhakeidecode/index.js';
import type {
  DecoderContext,
  DecoderEngine,
  DecoderEngineContext,
  DecoderPlugin,
  LogicGenerator,
  OutputEvent,
  SignalWindow,
  WaitToken,
} from '../../libhakeidecode/index.js';
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
export const SPI_ANN = Object.freeze({
  MISO_DATA: 0,
  MOSI_DATA: 1,
  MISO_BIT: 2,
  MOSI_BIT: 3,
  WARNING: 4,
  MISO_TRANSFER: 5,
  MOSI_TRANSFER: 6,
});
const CLK = 0,
  MISO = 1,
  MOSI = 2,
  CS = 3,
  MAX_TRANSFER_WORDS = 4096;
const BIT_TEXTS_0: readonly string[] = Object.freeze(['0']);
const BIT_TEXTS_1: readonly string[] = Object.freeze(['1']);
const HEX8: readonly string[] = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0').toUpperCase(),
);
const HEX8_TEXTS: readonly (readonly string[])[] = HEX8.map((hex) => Object.freeze([hex]));
const BIN1: readonly Uint8Array[] = Array.from({ length: 256 }, (_, value) => Uint8Array.of(value));

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
  private mosiRawBits: number[] = [];
  private misoRawBits: number[] = [];
  private bitSamples: bigint[] = [];
  private transferStart: bigint | null = null;
  private transferEnd: bigint | null = null;
  private mosiTransferWords: string[] = [];
  private misoTransferWords: string[] = [];
  private mosiTransferTruncated = false;
  private misoTransferTruncated = false;
  private firstSample: bigint | null = null;
  private wordIndex = 0;
  private edgeWait: WaitToken | null = null;

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
    this.mosiRawBits.length = 0;
    this.misoRawBits.length = 0;
    this.bitSamples.length = 0;
    this.transferStart = null;
    this.transferEnd = null;
    this.mosiTransferWords.length = 0;
    this.misoTransferWords.length = 0;
    this.mosiTransferTruncated = false;
    this.misoTransferTruncated = false;
    this.firstSample = null;
    this.wordIndex = 0;
    this.edgeWait = null;
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
    this.edgeWait = this.wait(this.hasCs ? [{ clk: 'e' }, { cs: 'e' }] : [{ clk: 'e' }]);
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) this.samplerate = value;
  }

  private warning(message: string): void {
    this.put(this.samplenum, this.samplenum, this.outAnn, [SPI_ANN.WARNING, [message]]);
    this.put(this.samplenum, this.samplenum, this.outProtocol, ['WARNING', message]);
  }

  private flushTransfers(endSample: bigint | null = null): void {
    const ss = this.transferStart,
      es = endSample ?? this.transferEnd;
    if (ss !== null && es !== null) {
      if (this.hasMiso && this.misoTransferWords.length) {
        const text = this.misoTransferTruncated
          ? this.misoTransferWords.join(' ') + ' ...'
          : this.misoTransferWords.join(' ');
        this.put(ss, es, this.outAnn, [SPI_ANN.MISO_TRANSFER, [text]]);
      }
      if (this.hasMosi && this.mosiTransferWords.length) {
        const text = this.mosiTransferTruncated
          ? this.mosiTransferWords.join(' ') + ' ...'
          : this.mosiTransferWords.join(' ');
        this.put(ss, es, this.outAnn, [SPI_ANN.MOSI_TRANSFER, [text]]);
      }
    }
    this.transferStart = null;
    this.transferEnd = null;
    this.mosiTransferWords.length = 0;
    this.misoTransferWords.length = 0;
    this.mosiTransferTruncated = false;
    this.misoTransferTruncated = false;
  }

  private discardPartial(reason: string): void {
    if (!this.bits) return;
    this.warning(reason + ': ' + this.bits + ' bit(s) discarded');
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.mosiRawBits.length = 0;
    this.misoRawBits.length = 0;
    this.bitSamples.length = 0;
    this.firstSample = null;
  }

  private binary(value: number): Uint8Array {
    if (this.options.wordsize <= 8) return BIN1[value & 0xff]!;
    const width = (this.options.wordsize + 7) >> 3;
    const out = new Uint8Array(width);
    for (let index = 0; index < width; index++) out[index] = (value >>> (8 * (width - index - 1))) & 0xff;
    return out;
  }

  private formatWord(value: number): string {
    if (this.options.wordsize <= 8 && this.options.wordsize > 4) return HEX8[value & 0xff]!;
    const digits = (this.options.wordsize + 3) >> 2;
    return value.toString(16).padStart(digits, '0').toUpperCase();
  }

  private emitWord(): void {
    const mosi = this.hasMosi ? this.mosi : null,
      miso = this.hasMiso ? this.miso : null,
      cs = this.hasCs ? this.csActive : null,
      ss = this.firstSample ?? this.samplenum,
      bitCount = this.bitSamples.length,
      lastSample = this.bitSamples[bitCount - 1] ?? this.samplenum,
      bitWidth = bitCount > 1 ? lastSample - this.bitSamples[bitCount - 2]! : 1n,
      annEs = lastSample + (bitWidth > 0n ? bitWidth : 1n);

    for (let i = 0; i < bitCount; i++) {
      const bSs = this.bitSamples[i]!,
        bEs = i + 1 < bitCount ? this.bitSamples[i + 1]! : annEs;
      if (miso !== null)
        this.put(bSs, bEs, this.outAnn, [SPI_ANN.MISO_BIT, this.misoRawBits[i] ? BIT_TEXTS_1 : BIT_TEXTS_0]);
      if (mosi !== null)
        this.put(bSs, bEs, this.outAnn, [SPI_ANN.MOSI_BIT, this.mosiRawBits[i] ? BIT_TEXTS_1 : BIT_TEXTS_0]);
    }

    if (miso !== null) {
      const useHex8 = this.options.wordsize <= 8 && this.options.wordsize > 4;
      const misoHex = useHex8 ? HEX8[miso & 0xff]! : this.formatWord(miso);
      this.put(ss, annEs, this.outAnn, [SPI_ANN.MISO_DATA, useHex8 ? HEX8_TEXTS[miso & 0xff]! : [misoHex], miso]);
      if (this.misoTransferWords.length < MAX_TRANSFER_WORDS) this.misoTransferWords.push(misoHex);
      else this.misoTransferTruncated = true;
    }
    if (mosi !== null) {
      const useHex8 = this.options.wordsize <= 8 && this.options.wordsize > 4;
      const mosiHex = useHex8 ? HEX8[mosi & 0xff]! : this.formatWord(mosi);
      this.put(ss, annEs, this.outAnn, [SPI_ANN.MOSI_DATA, useHex8 ? HEX8_TEXTS[mosi & 0xff]! : [mosiHex], mosi]);
      if (this.mosiTransferWords.length < MAX_TRANSFER_WORDS) this.mosiTransferWords.push(mosiHex);
      else this.mosiTransferTruncated = true;
    }
    if (this.transferStart === null) this.transferStart = ss;
    this.transferEnd = annEs;

    this.put(ss, this.samplenum, this.outProtocol, ['WORD', mosi, miso, cs, this.wordIndex]);
    if (mosi !== null) this.put(ss, this.samplenum, this.outBinary, [0, this.binary(mosi)]);
    if (miso !== null) this.put(ss, this.samplenum, this.outBinary, [1, this.binary(miso)]);
    this.wordIndex++;
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.mosiRawBits.length = 0;
    this.misoRawBits.length = 0;
    this.bitSamples.length = 0;
    this.firstSample = null;
  }

  private sample(mosi: number, miso: number): void {
    if (!this.bits) this.firstSample = this.samplenum;
    this.bitSamples.push(this.samplenum);
    this.mosiRawBits.push(mosi);
    this.misoRawBits.push(miso);
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
    const waitToken = this.edgeWait ?? this.wait(this.hasCs ? [{ clk: 'e' }, { cs: 'e' }] : [{ clk: 'e' }]);
    while (true) {
      pins = yield waitToken;
      const clk = Number(pins[CLK]),
        cs = this.hasCs ? Number(pins[CS]) : null;
      if (this.hasCs && cs !== previousCs) {
        const active = cs === (this.options.cs_polarity === 'active-low' ? 0 : 1);
        if (!active && this.csActive) {
          this.discardPartial('Chip select deasserted');
          this.flushTransfers(this.samplenum);
        }
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
    this.flushTransfers();
  }
}

function resolveChannelKey(
  mapping: DecoderEngineContext<SPIOptions>['channels'],
  id: string,
  index: number,
): string | null {
  const value = mapping[id] ?? mapping[index];
  if (value == null || value === false || value === -1) return null;
  return value === true ? id : String(value);
}

class SPIFastEngine implements DecoderEngine<readonly OutputEvent[]> {
  private readonly sink: DecoderEngineContext<SPIOptions>['sink'];
  private readonly options: SPIOptions;
  private readonly clkKey: string;
  private readonly misoKey: string | null;
  private readonly mosiKey: string | null;
  private readonly csKey: string | null;
  private readonly hasMiso: boolean;
  private readonly hasMosi: boolean;
  private readonly hasCs: boolean;
  private readonly csActiveLevel: number;
  private readonly sampleLevel: number;
  private readonly msbFirst: boolean;
  private readonly wordsize: number;
  private readonly hexDigits: number;
  private readonly byteWidth: number;
  private readonly useHex8: boolean;
  private readonly outputs: OutputStreams;
  private readonly outProtocol: number;
  private readonly outBinary: number;
  private readonly outAnn: number;
  private events: OutputEvent[] = [];
  private initialized = false;
  private ended = false;
  private previousClk = 0;
  private previousCs = 0;
  private csActive = true;
  private bits = 0;
  private mosi = 0;
  private miso = 0;
  private readonly mosiRawBits: number[] = [];
  private readonly misoRawBits: number[] = [];
  private readonly bitSamples: bigint[] = [];
  private transferStart: bigint | null = null;
  private transferEnd: bigint | null = null;
  private readonly mosiTransferWords: string[] = [];
  private readonly misoTransferWords: string[] = [];
  private mosiTransferTruncated = false;
  private misoTransferTruncated = false;
  private firstSample: bigint | null = null;
  private wordIndex = 0;
  private lastEndSample = 0n;

  constructor(context: DecoderEngineContext<SPIOptions>) {
    if (!context.sampleRate) throw new Error('Cannot decode without samplerate.');
    this.sink = context.sink;
    this.options = new SPIDecoder(context.options).options;
    const clkKey = resolveChannelKey(context.channels, 'clk', CLK);
    if (clkKey === null) throw new Error('Missing required channel: clk');
    this.clkKey = clkKey;
    this.misoKey = resolveChannelKey(context.channels, 'miso', MISO);
    this.mosiKey = resolveChannelKey(context.channels, 'mosi', MOSI);
    this.csKey = resolveChannelKey(context.channels, 'cs', CS);
    this.hasMiso = this.misoKey !== null;
    this.hasMosi = this.mosiKey !== null;
    this.hasCs = this.csKey !== null;
    if (!this.hasMiso && !this.hasMosi) throw new Error('SPI requires MISO or MOSI.');
    if (!Number.isInteger(this.options.wordsize) || this.options.wordsize < 1 || this.options.wordsize > 32)
      throw new Error('SPI word size must be 1..32.');
    this.csActiveLevel = this.options.cs_polarity === 'active-low' ? 0 : 1;
    this.sampleLevel = this.options.cpol === this.options.cpha ? 1 : 0;
    this.msbFirst = this.options.bitorder === 'msb-first';
    this.wordsize = this.options.wordsize;
    this.hexDigits = (this.wordsize + 3) >> 2;
    this.byteWidth = (this.wordsize + 7) >> 3;
    this.useHex8 = this.wordsize <= 8 && this.wordsize > 4;
    this.outputs = new OutputStreams(
      { descriptor },
      { instanceId: context.instanceId, onEvent: (event) => this.events.push(event) },
    );
    this.outProtocol = this.outputs.register(OUTPUT_PROTOCOL, 'spi');
    this.outBinary = this.outputs.register(OUTPUT_BINARY);
    this.outAnn = this.outputs.register(OUTPUT_ANN);
  }

  private warning(sample: bigint, message: string): void {
    this.outputs.put(sample, sample, this.outAnn, [SPI_ANN.WARNING, [message]]);
    this.outputs.put(sample, sample, this.outProtocol, ['WARNING', message]);
  }

  private flushTransfers(endSample: bigint | null = null): void {
    const ss = this.transferStart,
      es = endSample ?? this.transferEnd;
    if (ss !== null && es !== null) {
      if (this.hasMiso && this.misoTransferWords.length) {
        const text = this.misoTransferTruncated
          ? this.misoTransferWords.join(' ') + ' ...'
          : this.misoTransferWords.join(' ');
        this.outputs.put(ss, es, this.outAnn, [SPI_ANN.MISO_TRANSFER, [text]]);
      }
      if (this.hasMosi && this.mosiTransferWords.length) {
        const text = this.mosiTransferTruncated
          ? this.mosiTransferWords.join(' ') + ' ...'
          : this.mosiTransferWords.join(' ');
        this.outputs.put(ss, es, this.outAnn, [SPI_ANN.MOSI_TRANSFER, [text]]);
      }
    }
    this.transferStart = null;
    this.transferEnd = null;
    this.mosiTransferWords.length = 0;
    this.misoTransferWords.length = 0;
    this.mosiTransferTruncated = false;
    this.misoTransferTruncated = false;
  }

  private discardPartial(sample: bigint, reason: string): void {
    if (!this.bits) return;
    this.warning(sample, reason + ': ' + this.bits + ' bit(s) discarded');
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.mosiRawBits.length = 0;
    this.misoRawBits.length = 0;
    this.bitSamples.length = 0;
    this.firstSample = null;
  }

  private binary(value: number): Uint8Array {
    if (this.wordsize <= 8) return BIN1[value & 0xff]!;
    const width = this.byteWidth;
    const out = new Uint8Array(width);
    for (let index = 0; index < width; index++) out[index] = (value >>> (8 * (width - index - 1))) & 0xff;
    return out;
  }

  private emitWord(sample: bigint): void {
    const mosi = this.hasMosi ? this.mosi : null,
      miso = this.hasMiso ? this.miso : null,
      cs = this.hasCs ? this.csActive : null,
      ss = this.firstSample ?? sample,
      bitCount = this.bitSamples.length,
      lastSample = this.bitSamples[bitCount - 1] ?? sample,
      bitWidth = bitCount > 1 ? lastSample - this.bitSamples[bitCount - 2]! : 1n,
      annEs = lastSample + (bitWidth > 0n ? bitWidth : 1n);

    for (let i = 0; i < bitCount; i++) {
      const bSs = this.bitSamples[i]!,
        bEs = i + 1 < bitCount ? this.bitSamples[i + 1]! : annEs;
      if (miso !== null)
        this.outputs.put(bSs, bEs, this.outAnn, [SPI_ANN.MISO_BIT, this.misoRawBits[i] ? BIT_TEXTS_1 : BIT_TEXTS_0]);
      if (mosi !== null)
        this.outputs.put(bSs, bEs, this.outAnn, [SPI_ANN.MOSI_BIT, this.mosiRawBits[i] ? BIT_TEXTS_1 : BIT_TEXTS_0]);
    }

    if (miso !== null) {
      const misoHex = this.useHex8 ? HEX8[miso & 0xff]! : miso.toString(16).padStart(this.hexDigits, '0').toUpperCase();
      this.outputs.put(ss, annEs, this.outAnn, [
        SPI_ANN.MISO_DATA,
        this.useHex8 ? HEX8_TEXTS[miso & 0xff]! : [misoHex],
        miso,
      ]);
      if (this.misoTransferWords.length < MAX_TRANSFER_WORDS) this.misoTransferWords.push(misoHex);
      else this.misoTransferTruncated = true;
    }
    if (mosi !== null) {
      const mosiHex = this.useHex8 ? HEX8[mosi & 0xff]! : mosi.toString(16).padStart(this.hexDigits, '0').toUpperCase();
      this.outputs.put(ss, annEs, this.outAnn, [
        SPI_ANN.MOSI_DATA,
        this.useHex8 ? HEX8_TEXTS[mosi & 0xff]! : [mosiHex],
        mosi,
      ]);
      if (this.mosiTransferWords.length < MAX_TRANSFER_WORDS) this.mosiTransferWords.push(mosiHex);
      else this.mosiTransferTruncated = true;
    }
    if (this.transferStart === null) this.transferStart = ss;
    this.transferEnd = annEs;

    this.outputs.put(ss, sample, this.outProtocol, ['WORD', mosi, miso, cs, this.wordIndex]);
    if (mosi !== null) this.outputs.put(ss, sample, this.outBinary, [0, this.binary(mosi)]);
    if (miso !== null) this.outputs.put(ss, sample, this.outBinary, [1, this.binary(miso)]);
    this.wordIndex++;
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.mosiRawBits.length = 0;
    this.misoRawBits.length = 0;
    this.bitSamples.length = 0;
    this.firstSample = null;
  }

  private sampleBit(sample: bigint, mosi: number, miso: number): void {
    if (!this.bits) this.firstSample = sample;
    this.bitSamples.push(sample);
    this.mosiRawBits.push(mosi);
    this.misoRawBits.push(miso);
    if (this.msbFirst) {
      this.mosi = ((this.mosi << 1) | mosi) >>> 0;
      this.miso = ((this.miso << 1) | miso) >>> 0;
    } else {
      this.mosi += mosi * 2 ** this.bits;
      this.miso += miso * 2 ** this.bits;
    }
    this.bits++;
    if (this.bits === this.wordsize) this.emitWord(sample);
  }

  private handleTransition(sample: bigint, clk: number, cs: number, mosi: number, miso: number): void {
    if (this.hasCs && cs !== this.previousCs) {
      const active = cs === this.csActiveLevel;
      if (!active && this.csActive) {
        this.discardPartial(sample, 'Chip select deasserted');
        this.flushTransfers(sample);
      }
      this.csActive = active;
    }
    if (clk === this.sampleLevel && this.previousClk !== clk && this.csActive) this.sampleBit(sample, mosi, miso);
    this.previousClk = clk;
    this.previousCs = cs;
  }

  async push(window: SignalWindow): Promise<void> {
    if (this.ended) return;
    const len = window.length;
    this.lastEndSample = window.endSample;
    if (len <= 0) return;

    const clkWin = window.channel(this.clkKey) ?? window.channel('clk') ?? window.channel(CLK);
    if (!clkWin) throw new Error(`Input chunk has no mapped channel: ${this.clkKey}`);
    const misoWin = this.hasMiso
      ? (window.channel(this.misoKey!) ?? window.channel('miso') ?? window.channel(MISO))
      : undefined;
    const mosiWin = this.hasMosi
      ? (window.channel(this.mosiKey!) ?? window.channel('mosi') ?? window.channel(MOSI))
      : undefined;
    const csWin = this.hasCs ? (window.channel(this.csKey!) ?? window.channel('cs') ?? window.channel(CS)) : undefined;
    if (this.hasMiso && !misoWin) throw new Error(`Input chunk has no mapped channel: ${this.misoKey}`);
    if (this.hasMosi && !mosiWin) throw new Error(`Input chunk has no mapped channel: ${this.mosiKey}`);
    if (this.hasCs && !csWin) throw new Error(`Input chunk has no mapped channel: ${this.csKey}`);

    const startSample = window.startSample;

    // Fast path: all mapped channels come from the same 1-byte packed Uint8Array buffer!
    if (
      clkWin.kind === 'packed' &&
      clkWin.sampleBytes === 1 &&
      clkWin.data instanceof Uint8Array &&
      (!misoWin || (misoWin.kind === 'packed' && misoWin.sampleBytes === 1 && misoWin.data === clkWin.data)) &&
      (!mosiWin || (mosiWin.kind === 'packed' && mosiWin.sampleBytes === 1 && mosiWin.data === clkWin.data)) &&
      (!csWin || (csWin.kind === 'packed' && csWin.sampleBytes === 1 && csWin.data === clkWin.data))
    ) {
      const data = clkWin.data;
      const clkBit = clkWin.bit!;
      const clkMask = 1 << clkBit;
      const misoBit = misoWin ? misoWin.bit! : 0;
      const mosiBit = mosiWin ? mosiWin.bit! : 0;
      const csBit = csWin ? csWin.bit! : 0;
      const csMask = csWin ? 1 << csBit : 0;
      const watchMask = clkMask | csMask;
      const hasCs = this.hasCs;
      const hasMiso = this.hasMiso;
      const hasMosi = this.hasMosi;
      const sampleLevel = this.sampleLevel;
      const csActiveLevel = this.csActiveLevel;

      let cursor = 0;
      if (!this.initialized) {
        const firstByte = data[0]!;
        this.previousClk = (firstByte >>> clkBit) & 1;
        this.previousCs = hasCs ? (firstByte >>> csBit) & 1 : 0;
        if (hasCs) this.csActive = this.previousCs === csActiveLevel;
        this.initialized = true;
        cursor = 1;
      }

      const head = (4 - (data.byteOffset & 3)) & 3;
      const wordCount = data.byteLength > head ? (data.byteLength - head) >>> 2 : 0;
      const words = wordCount > 0 ? new Uint32Array(data.buffer, data.byteOffset + head, wordCount) : null;
      const watchMask4 = (watchMask * 0x01010101) >>> 0;

      let prevWatch = (this.previousClk ? clkMask : 0) | (hasCs && this.previousCs ? csMask : 0);
      while (cursor < len) {
        if ((data[cursor]! & watchMask) === prevWatch) {
          if (words && len - cursor >= 16) {
            const alignStop =
              cursor < head ? Math.min(len, head) : Math.min(len, cursor + ((4 - ((cursor - head) & 3)) & 3));
            while (cursor < alignStop && (data[cursor]! & watchMask) === prevWatch) cursor++;
            if (cursor < len && (data[cursor]! & watchMask) === prevWatch && cursor >= head && cursor + 4 <= len) {
              const target4 = (prevWatch * 0x01010101) >>> 0;
              let wordIdx = (cursor - head) >>> 2;
              const wordStop = Math.min(words.length, (len - head) >>> 2);
              while (wordIdx < wordStop && (words[wordIdx]! & watchMask4) >>> 0 === target4) wordIdx++;
              cursor = head + (wordIdx << 2);
            }
          }
          while (cursor < len && (data[cursor]! & watchMask) === prevWatch) cursor++;
          if (cursor >= len) break;
        }
        const b = data[cursor]!;
        const clk = (b >>> clkBit) & 1;
        const cs = hasCs ? (b >>> csBit) & 1 : 0;
        const sample = startSample + BigInt(cursor);
        if (hasCs && cs !== this.previousCs) {
          const active = cs === csActiveLevel;
          if (!active && this.csActive) {
            this.discardPartial(sample, 'Chip select deasserted');
            this.flushTransfers(sample);
          }
          this.csActive = active;
        }
        if (clk === sampleLevel && this.previousClk !== clk && this.csActive) {
          this.sampleBit(sample, hasMosi ? (b >>> mosiBit) & 1 : 0, hasMiso ? (b >>> misoBit) & 1 : 0);
        }
        this.previousClk = clk;
        this.previousCs = cs;
        prevWatch = b & watchMask;
        cursor++;
      }
    } else {
      let cursor = 0;
      if (!this.initialized) {
        this.previousClk = Number(clkWin.at(0));
        this.previousCs = this.hasCs ? Number(csWin!.at(0)) : 0;
        if (this.hasCs) this.csActive = this.previousCs === this.csActiveLevel;
        this.initialized = true;
        cursor = 1;
      }
      while (cursor < len) {
        const clk = Number(clkWin.at(cursor));
        const cs = this.hasCs ? Number(csWin!.at(cursor)) : 0;
        if (clk !== this.previousClk || (this.hasCs && cs !== this.previousCs)) {
          this.handleTransition(
            startSample + BigInt(cursor),
            clk,
            cs,
            this.hasMosi ? Number(mosiWin!.at(cursor)) : 0,
            this.hasMiso ? Number(misoWin!.at(cursor)) : 0,
          );
          cursor++;
        } else {
          const nextClk = clkWin.nextEdge(cursor + 1, len);
          const next = this.hasCs ? csWin!.nextEdge(cursor + 1, nextClk) : nextClk;
          cursor = next;
        }
      }
    }

    if (this.events.length) {
      const batch = this.events;
      this.events = [];
      await this.sink.write(batch);
    }
  }

  async flush(): Promise<void> {
    if (this.events.length) {
      const batch = this.events;
      this.events = [];
      await this.sink.write(batch);
    }
  }

  async finish(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.bits) this.discardPartial(this.lastEndSample, 'End of capture');
    this.flushTransfers();
    await this.flush();
  }

  reset(): void {
    this.events = [];
    this.initialized = false;
    this.ended = false;
    this.previousClk = 0;
    this.previousCs = 0;
    this.csActive = true;
    this.bits = 0;
    this.mosi = 0;
    this.miso = 0;
    this.mosiRawBits.length = 0;
    this.misoRawBits.length = 0;
    this.bitSamples.length = 0;
    this.transferStart = null;
    this.transferEnd = null;
    this.mosiTransferWords.length = 0;
    this.misoTransferWords.length = 0;
    this.mosiTransferTruncated = false;
    this.misoTransferTruncated = false;
    this.firstSample = null;
    this.wordIndex = 0;
    this.lastEndSample = 0n;
  }

  cancel(): void {
    this.ended = true;
    this.events = [];
  }
}

export const spiPlugin: DecoderPlugin<any, any> = {
  decoder: SPIDecoder,
  descriptor,
  createEngine: (context) => new SPIFastEngine(context),
};

export default SPIDecoder;
