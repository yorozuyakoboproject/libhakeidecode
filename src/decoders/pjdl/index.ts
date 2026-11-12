import { Decoder, OUTPUT_ANN, OUTPUT_PROTOCOL, SRD_CONF_SAMPLERATE } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, Pins } from '../../libhakeidecode/index.js';
import { bitpack } from '../common.js';
import type { OptionValue } from '../../libhakeidecode/types.js';
import { descriptor } from './descriptor.js';

const ANN = Object.freeze({
  CARRIER_BUSY: 0,
  CARRIER_IDLE: 1,
  PAD_BIT: 2,
  LOW_BIT: 3,
  DATA_BIT: 4,
  SHORT_DATA: 5,
  SYNC_LOSS: 6,
  DATA_BYTE: 7,
  FRAME_INIT: 8,
  FRAME_BYTES: 9,
  FRAME_WAIT: 10,
});

interface Symbol {
  ss: bigint;
  es: bigint;
  name: string;
  data: unknown;
}

const MODE_TIMES: Readonly<Record<number, readonly [number, number]>> = {
  1: [44, 116],
  2: [40, 92],
  3: [28, 88],
  4: [26, 60],
};

export class PjdlDecoder extends Decoder<Record<string, OptionValue>> {
  static descriptor = descriptor;

  private samplerate: number | null = null;
  private carrierWantIdle = true;
  private carrierIsBusy = false;
  private carrierIsIdle = false;
  private carrierIdleSs: number | null = null;
  private carrierBusySs: number | null = null;
  private syncpadFallSs: number | null = null;
  private edges: bigint[] | null = null;
  private symbols: Symbol[] | null = null;
  private syncPads: bigint[] | null = null;
  private dataBits: number[] | null = null;
  private frameBytes: number[] | null = null;
  private shortBits: bigint[] | null = null;
  private dataWidth = 0;
  private padWidth = 0;
  private byteWidth = 0;
  private idleWidth = 0;
  private usecWidth = 0;
  private holdHighWidth = 0;
  private lookaheadWidth = 0;
  private data1Range: readonly [number, number] = [0, -1];
  private data2Range: readonly [number, number] = [0, -1];
  private data3Range: readonly [number, number] = [0, -1];
  private data4Range: readonly [number, number] = [0, -1];
  private shortRange: readonly [number, number] = [0, -1];
  private padRange: readonly [number, number] = [0, -1];
  private dataFallTime = 0;
  private outAnn = -1;
  private outProtocol = -1;

  constructor(options: Partial<Record<string, OptionValue>> = {}) {
    super(options);
    this.reset();
  }

  override reset(): void {
    this.resetState();
  }

  private resetState(): void {
    this.carrierWantIdle = true;
    this.carrierIsBusy = false;
    this.carrierIsIdle = false;
    this.carrierIdleSs = null;
    this.carrierBusySs = null;
    this.syncpadFallSs = null;
    this.edges = null;
    this.symbols = null;
    this.syncPads = null;
    this.dataBits = null;
    this.frameBytes = null;
    this.shortBits = null;
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outAnn = this.register(OUTPUT_ANN);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, 'pjon_link');
  }

  override metadata(key: number, value: number): void {
    if (key === SRD_CONF_SAMPLERATE) {
      this.samplerate = value;
      this.spanPrepare();
    }
  }

  private putg(ss: bigint, es: bigint, classIndex: number, texts: readonly string[]): void {
    if (classIndex === ANN.CARRIER_BUSY || classIndex === ANN.CARRIER_IDLE || classIndex === ANN.SYNC_LOSS) return;
    this.put(ss, es, this.outAnn, [classIndex, texts]);
  }

  private putpy(ss: bigint, es: bigint, type: string, data: unknown): void {
    this.put(ss, es, this.outProtocol, [type, data]);
  }

  private symbolsClear(): Symbol[] {
    const symbols = this.symbols ?? [];
    this.symbols = [];
    return symbols;
  }

  private symbolsAppend(ss: bigint, es: bigint, name: string, data: unknown = null): void {
    this.symbols ??= [];
    this.symbols.push({ ss, es, name, data });
  }

  private symbolsGetLast(count = 1): Symbol | Symbol[] | null {
    if (!this.symbols?.length || this.symbols.length < count) return null;
    const items = this.symbols.slice(-count);
    return count === 1 ? items[0]! : items;
  }

  private symbolsUpdateLast(ss: bigint | null, es: bigint | null, name: string | null, data?: unknown): void {
    if (!this.symbols?.length) return;
    const item = this.symbols.at(-1)!;
    if (ss !== null) item.ss = ss;
    if (es !== null) item.es = es;
    if (name !== null) item.name = name;
    if (data !== undefined) item.data = data;
  }

  private symbolsHasPrev(want: string | readonly string[]): boolean {
    const items = typeof want === 'string' ? [want] : want;
    if (!this.symbols || this.symbols.length < items.length) return false;
    const offset = this.symbols.length - items.length;
    return items.every((item, index) => this.symbols![offset + index]!.name === item);
  }

  private symbolsCollapse(count: number, name: string, data: unknown = undefined, squeeze?: string): void {
    if (!this.symbols || this.symbols.length < count) return;
    const last = this.symbols.splice(this.symbols.length - count, count);
    while (squeeze && this.symbols.length && this.symbols.at(-1)!.name === squeeze) last.unshift(this.symbols.pop()!);
    this.symbols.push({
      ss: last[0]!.ss,
      es: last.at(-1)!.es,
      name,
      data: data === undefined ? last : data,
    });
  }

  private frameFlush(): void {
    const symbols = this.symbolsClear();
    while (symbols[0]?.name === 'IDLE') symbols.shift();
    while (symbols.at(-1)?.name === 'IDLE') symbols.pop();
    if (!symbols.length) return;
    const texts: string[] = [];
    const data: unknown[] = [];
    for (const symbol of symbols) {
      if (symbol.name === 'FRAME_INIT') {
        texts.push('INIT');
        data.push('INIT');
      } else if (symbol.name === 'SYNC_PAD') {
        if (texts.at(-1) !== 'SYNC') {
          texts.push('SYNC');
          data.push('SYNC');
        }
      } else if (symbol.name === 'DATA_BYTE') {
        const bits = (symbol.data as Symbol[])
          .filter((item) => item.name === 'DATA_BIT')
          .map((item) => Number(item.data));
        const value = bitpack(bits);
        texts.push(value.toString(16).padStart(2, '0'));
        data.push(value);
      } else if (symbol.name === 'SHORT_BIT') {
        if (texts.at(-1) !== 'SHORT') {
          texts.push('SHORT');
          data.push('SHORT');
        }
      } else if (symbol.name === 'WAIT_ACK') {
        texts.push('WAIT');
        data.push('WAIT');
      }
    }
    this.putg(symbols[0]!.ss, symbols.at(-1)!.es, ANN.FRAME_BYTES, [texts.join(' ')]);
    this.putpy(symbols[0]!.ss, symbols.at(-1)!.es, 'FRAME_DATA', data);
  }

  private carrierFlush(): void {
    if (this.carrierBusySs !== null) this.putg(BigInt(this.carrierBusySs), this.samplenum, ANN.CARRIER_BUSY, ['BUSY']);
    if (this.carrierIdleSs !== null) {
      const ss = BigInt(this.carrierIdleSs + Math.trunc(this.idleWidth));
      if (ss < this.samplenum) this.putg(ss, this.samplenum, ANN.CARRIER_IDLE, ['IDLE']);
    }
  }

  private carrierSetIdle(on: boolean, ss: bigint, es: bigint): void {
    if (on) {
      if (this.carrierIdleSs === null) this.carrierIdleSs = Number(ss);
      if (!this.symbolsHasPrev('IDLE')) this.symbolsAppend(ss, ss, 'IDLE');
      this.symbolsUpdateLast(null, es, null);
      this.frameFlush();
      this.resetState();
      this.carrierIsIdle = true;
      this.carrierWantIdle = false;
      return;
    }
    if (this.symbolsHasPrev('IDLE')) this.symbolsUpdateLast(null, es, null);
    this.carrierFlush();
    this.carrierIsIdle = false;
    this.carrierIdleSs = null;
  }

  private carrierSetBusy(on: boolean, sample: number): void {
    this.carrierIsBusy = on;
    if (on) {
      this.carrierIsIdle = false;
      if (this.carrierBusySs === null) this.carrierBusySs = sample;
      return;
    }
    this.carrierBusySs = null;
  }

  private carrierCheck(level: number, sample: bigint): void {
    if (level) {
      this.carrierSetIdle(false, sample, sample);
      this.carrierSetBusy(true, Number(sample));
      return;
    }
    if (this.carrierIdleSs === null) this.carrierIdleSs = Number(sample);
    const span = Number(sample) - this.carrierIdleSs;
    if (span >= this.byteWidth) this.carrierSetBusy(false, Number(sample));
    if (span >= this.idleWidth)
      this.carrierSetIdle(true, BigInt(this.carrierIdleSs + Math.trunc(this.idleWidth)), sample);
  }

  private spanPrepare(): void {
    if (!this.samplerate) return;
    const times = MODE_TIMES[Number(this.options.mode)] ?? MODE_TIMES[1]!;
    this.dataWidth = times[0];
    this.padWidth = times[1];
    this.byteWidth = this.padWidth + 9 * this.dataWidth;
    this.idleWidth = this.byteWidth + Number(this.options.idle_add_us);
    this.usecWidth = this.samplerate / 1e6;
    this.holdHighWidth = 9 * 1.5 * this.usecWidth;
    const range = (width: number): [number, number] => {
      const relative = width * 0.1;
      const lower = Math.min(width - relative, width - 1.5);
      const upper = Math.max(width + relative, width + 1.5);
      return [Math.floor(lower * this.usecWidth), Math.ceil(upper * this.usecWidth)];
    };
    this.data1Range = range(this.dataWidth);
    this.data2Range = range(this.dataWidth * 2);
    this.data3Range = range(this.dataWidth * 3);
    this.data4Range = range(this.dataWidth * 4);
    this.shortRange = range(this.dataWidth / 4);
    this.padRange = range(this.padWidth);
    this.dataWidth *= this.usecWidth;
    this.padWidth *= this.usecWidth;
    this.byteWidth *= this.usecWidth;
    this.idleWidth *= this.usecWidth;
    this.lookaheadWidth = Math.trunc(4 * this.dataWidth);
  }

  private spanIsPad(span: number): boolean {
    return span >= this.padRange[0] && span <= this.padRange[1];
  }

  private spanIsData(span: number): number {
    for (const [kind, range] of [
      [1, this.data1Range],
      [2, this.data2Range],
      [3, this.data3Range],
      [4, this.data4Range],
    ] as const)
      if (span >= range[0] && span <= range[1]) return kind;
    return 0;
  }

  private spanIsShort(span: number): boolean {
    return span >= this.shortRange[0] && span <= this.shortRange[1];
  }

  private *waitUntil(want: number): Generator<ReturnType<Decoder['wait']>, Pins, Pins> {
    while (true) {
      const difference = Math.max(Math.trunc(want - Number(this.samplenum)), 1);
      const pins = yield this.wait([{ data: 'e' }, { skip: difference }]);
      this.carrierCheck(Number(pins[0] ?? 0), this.samplenum);
      if (Number(this.samplenum) >= want) return pins;
    }
  }

  *decode(): LogicGenerator {
    if (!this.samplerate || this.samplerate < 1e6) throw new Error('Need a samplerate of at least 1MSa/s');
    while (true) {
      if (!this.edges) {
        const pins = yield this.wait({ data: 'l' });
        this.carrierCheck(Number(pins[0] ?? 0), this.samplenum);
        this.edges = [this.samplenum];
        continue;
      }

      const lastSample = this.samplenum;
      let pins = yield this.wait([{ data: 'e' }, { skip: this.lookaheadWidth }]);
      this.carrierCheck(Number(pins[0] ?? 0), this.samplenum);
      let bitLevel = Number(pins[0] ?? 0);
      const edgeSeen = this.matched?.[0] === true;
      if (edgeSeen) bitLevel = 1 - bitLevel;
      if (!this.edges) {
        this.edges = [this.samplenum];
        continue;
      }
      this.edges.push(this.samplenum);
      const currentSample = this.samplenum;
      const span = Number(currentSample - this.edges.at(-2)!);
      const isPad = bitLevel === 1 && this.spanIsPad(span);
      let isData = this.spanIsData(span);
      const isShort = bitLevel === 1 && this.spanIsShort(span);

      if (isPad) {
        const ss = this.edges.at(-2)!;
        this.putg(ss, currentSample, ANN.PAD_BIT, ['PAD', String(bitLevel)]);
        this.symbolsAppend(ss, currentSample, 'PAD_BIT', bitLevel);
        const last = this.symbolsGetLast() as Symbol;
        this.putpy(last.ss, last.es, 'PAD_BIT', bitLevel);
        continue;
      }
      if (isShort) {
        this.putg(lastSample, currentSample, ANN.SHORT_DATA, ['SHORT', String(bitLevel)]);
        this.symbolsAppend(lastSample, currentSample, 'SHORT_BIT', bitLevel);
        const last = this.symbolsGetLast() as Symbol;
        this.putpy(last.ss, last.es, 'SHORT_BIT', bitLevel);
        continue;
      }
      if (bitLevel === 0 && !this.symbols?.length && this.carrierWantIdle) continue;
      if (bitLevel === 0) {
        if (this.symbolsHasPrev('DATA_BYTE') || this.symbolsHasPrev('SHORT_BIT') || this.symbolsHasPrev('WAIT_ACK'))
          continue;
      }

      let tookLow = false;
      let lastSnum = lastSample;
      if (isData && bitLevel === 0 && this.symbolsHasPrev('PAD_BIT')) {
        tookLow = true;
        isData--;
        const nextSample = lastSnum + BigInt(Math.trunc(this.dataWidth));
        this.putg(lastSnum, nextSample, ANN.LOW_BIT, ['ZERO', String(bitLevel)]);
        this.symbolsAppend(lastSnum, nextSample, 'ZERO_BIT', bitLevel);
        const last = this.symbolsGetLast() as Symbol;
        this.putpy(last.ss, last.es, 'DATA_BIT', bitLevel);
        this.dataFallTime = Number(lastSnum);
        lastSnum = nextSample;
      }
      if (this.symbolsHasPrev(['PAD_BIT', 'ZERO_BIT'])) {
        this.symbolsCollapse(2, 'SYNC_PAD');
        const last = this.symbolsGetLast() as Symbol;
        this.putpy(last.ss, last.es, 'SYNC_PAD', true);
        this.dataBits = [];
      }
      if (this.symbolsHasPrev(['SYNC_PAD', 'SYNC_PAD', 'SYNC_PAD'])) {
        this.symbolsCollapse(3, 'FRAME_INIT');
        if ((this.symbols?.length ?? 0) > 1) {
          const keep = this.symbols!.pop()!;
          this.frameFlush();
          this.symbols = [];
          this.symbols.push(keep);
        }
        const last = this.symbolsGetLast() as Symbol;
        this.putg(last.ss, last.es, ANN.FRAME_INIT, ['FRAME INIT', 'INIT', 'I']);
        this.putpy(last.ss, last.es, 'FRAME_INIT', true);
        this.frameBytes = [];
      }
      if (this.symbolsHasPrev(['SHORT_BIT', 'SYNC_PAD'])) {
        this.symbolsCollapse(2, 'WAIT_ACK', undefined, 'SHORT_BIT');
        const last = this.symbolsGetLast() as Symbol;
        this.putg(last.ss, last.es, ANN.FRAME_WAIT, ['WAIT for sync response', 'WAIT response', 'WAIT', 'W']);
        this.putpy(last.ss, last.es, 'SYNC_RESP_WAIT', true);
      }
      if (tookLow && !isData) continue;

      if (!isData) {
        const fastContinue = edgeSeen && bitLevel === 1;
        this.putg(lastSnum, currentSample, ANN.SYNC_LOSS, ['failed pulse length check', 'pulse length', 'length']);
        this.frameFlush();
        this.carrierFlush();
        this.resetState();
        if (fastContinue) this.edges = [this.samplenum];
        continue;
      }
      if (!this.symbolsHasPrev('SYNC_PAD')) {
        const fastContinue = edgeSeen && bitLevel === 1;
        this.frameFlush();
        this.carrierFlush();
        this.resetState();
        if (fastContinue) this.edges = [this.samplenum];
        continue;
      }

      const bitField: number[] = [];
      let bitStart = this.dataFallTime + this.dataWidth;
      for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
        const bitEnd = bitStart + this.dataWidth;
        const bitSample = (bitEnd + bitStart) / 2;
        if (bitSample > Number(this.samplenum)) {
          pins = yield* this.waitUntil(bitSample);
          bitLevel = Number(pins[0] ?? 0);
        }
        const ss = BigInt(Math.ceil(bitStart));
        const es = BigInt(Math.floor(bitEnd));
        this.putg(ss, es, ANN.DATA_BIT, [String(bitLevel)]);
        this.symbolsAppend(ss, es, 'DATA_BIT', bitLevel);
        const last = this.symbolsGetLast() as Symbol;
        this.putpy(last.ss, last.es, 'DATA_BIT', bitLevel);
        bitField.push(bitLevel);
        this.dataBits?.push(bitLevel);
        bitStart = bitEnd;
      }
      const endSample = bitStart;
      pins = yield* this.waitUntil(endSample);
      let currentLevel = Number(pins[0] ?? 0);
      let currentSnum = this.samplenum;
      if (currentLevel) {
        const hold = Math.trunc(this.holdHighWidth);
        pins = yield this.wait([{ data: 'l' }, { skip: hold }]);
        currentLevel = Number(pins[0] ?? 0);
        this.carrierCheck(currentLevel, this.samplenum);
        if (this.matched?.[1]) {
          this.edges.push(currentSnum);
          currentLevel = 1 - currentLevel;
        }
        currentSnum = this.samplenum;
      }

      let dataByte = bitpack(bitField);
      if (this.dataBits) {
        dataByte = bitpack(this.dataBits);
        this.dataBits = [];
        this.frameBytes?.push(dataByte);
      }
      if (this.symbolsHasPrev(['SYNC_PAD', ...Array<string>(8).fill('DATA_BIT')])) {
        this.symbolsCollapse(9, 'DATA_BYTE');
        const last = this.symbolsGetLast() as Symbol;
        this.putg(last.ss, last.es, ANN.DATA_BYTE, [dataByte.toString(16).padStart(2, '0')]);
        this.putpy(last.ss, last.es, 'DATA_BYTE', dataByte);
      }
      if (this.symbolsHasPrev(['WAIT_ACK', 'DATA_BYTE'])) this.frameFlush();
    }
  }
}

export default PjdlDecoder;
