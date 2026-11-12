import { Decoder, EOFError, OUTPUT_ANN, OUTPUT_BINARY, OUTPUT_PROTOCOL } from '../../libhakeidecode/index.js';
import type { DecoderContext, LogicGenerator, WaitCondition, WaitPredicate } from '../../libhakeidecode/index.js';
import { descriptor } from './descriptor.js';

export interface ParallelOptions {
  clock_edge: string;
  reset_polarity: string;
  wordsize: number;
  endianness: string;
}

const DATA_CHANNELS = 16;
const DATA_PIN = 1;
const RESET_PIN = DATA_PIN + DATA_CHANNELS;

function edgePredicate(edge: string): WaitPredicate {
  if (edge === 'rising') return 'r';
  if (edge === 'falling') return 'f';
  return 'e';
}

function itemText(value: number, bits: number): string {
  return value.toString(16).padStart(Math.ceil(bits / 4), '0');
}

function wireInteger(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export function parallelItemBytes(value: number, busWidth: number): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(busWidth / 8));
  for (let index = bytes.length - 1; index >= 0; index--) {
    bytes[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return bytes;
}

interface PendingItem {
  readonly ss: bigint;
  readonly data: number;
}

interface WordItem {
  readonly ss: bigint;
  es?: bigint;
  readonly data: number;
}

export class ParallelDecoder extends Decoder<ParallelOptions> {
  static descriptor = descriptor;
  private outProtocol = -1;
  private outBinary = -1;
  private outAnn = -1;
  private pending: PendingItem | null = null;
  private words: WordItem[] = [];

  override reset(): void {
    this.pending = null;
    this.words = [];
  }

  override start(ctx: DecoderContext): void {
    super.start(ctx);
    this.outProtocol = this.register(OUTPUT_PROTOCOL, descriptor.outputs![0]);
    this.outBinary = this.register(OUTPUT_BINARY);
    this.outAnn = this.register(OUTPUT_ANN);
  }

  private handleBits(now: bigint, item: number | null, busWidth: number): void {
    if (this.pending) {
      const { ss, data } = this.pending;
      this.pending = null;
      this.put(ss, now, this.outAnn, [0, [itemText(data, busWidth)]]);
      this.put(ss, now, this.outProtocol, ['ITEM', [data, busWidth]]);
      this.put(ss, now, this.outBinary, [0, parallelItemBytes(data, busWidth)]);
    }
    if (item !== null) this.pending = { ss: now, data: item };
    this.queueWord(now, item, busWidth);
  }

  private queueWord(now: bigint, item: number | null, busWidth: number): void {
    const wordsize = Math.trunc(this.options.wordsize);
    if (!wordsize) return;
    if (this.words.length) {
      this.words[this.words.length - 1]!.es = now;
      if (this.words.length === wordsize) this.flushWord(busWidth);
    }
    if (item !== null) this.words.push({ ss: now, data: item });
  }

  private flushWord(busWidth: number): void {
    if (!this.words.length) return;
    const wordsize = Math.trunc(this.options.wordsize);
    const items = this.words.map((entry) => entry.data);
    if (this.options.endianness === 'big') items.reverse();
    let word = 0n;
    for (let index = 0; index < items.length; index++) word |= BigInt(items[index]!) << BigInt(index * busWidth);
    const ss = this.words[0]!.ss;
    const es = this.words[this.words.length - 1]!.es!;
    const digits = Math.ceil((busWidth * wordsize) / 4);
    this.put(ss, es, this.outAnn, [1, [word.toString(16).padStart(digits, '0')]]);
    this.put(ss, es, this.outProtocol, ['WORD', [wireInteger(word), busWidth, wordsize]]);
    if (items.length !== wordsize) this.put(ss, es, this.outAnn, [2, ['incomplete word size', 'word size', 'ws']]);
    this.words = [];
  }

  *decode(): LogicGenerator {
    const present = Array.from({ length: DATA_CHANNELS }, (_, index) => this.hasChannel(`d${index}`));
    const connected = present.flatMap((value, index) => (value ? [index] : []));
    if (!connected.length) throw new Error('Need at least one data channel.');
    const busWidth = connected[connected.length - 1]! + 1;
    const dataIndices = Array.from({ length: busWidth }, (_, index) => (present[index] ? index : null));
    const conditions: WaitCondition[] = [];
    const haveClock = this.hasChannel('clk');
    if (haveClock) conditions.push({ clk: edgePredicate(this.options.clock_edge) });
    else for (const index of connected) conditions.push({ [`d${index}`]: 'e' as WaitPredicate });
    const dataStart = haveClock ? -1 : 0;
    const dataEnd = haveClock ? -1 : conditions.length;
    const haveReset = this.hasChannel('rst');
    const resetIndex = haveReset ? conditions.length : -1;
    if (haveReset) conditions.push({ rst: 'e' });
    const resetActive = this.options.reset_polarity === 'high-active' ? 1 : 0;
    let inReset = false;

    while (true) {
      let pins: number[];
      try {
        pins = yield this.wait(conditions);
      } catch (error) {
        if (error instanceof EOFError) break;
        throw error;
      }
      const matched = this.matched ?? [];
      const clockEdge = haveClock && !!matched[0];
      const dataEdge = dataStart >= 0 && matched.slice(dataStart, dataEnd).some(Boolean);
      const resetEdge = resetIndex >= 0 && !!matched[resetIndex];
      if (resetEdge) {
        inReset = pins[RESET_PIN] === resetActive;
        if (inReset) {
          this.handleBits(this.samplenum, null, busWidth);
          this.flushWord(busWidth);
        }
      }
      if (inReset) continue;
      if (!clockEdge && !dataEdge) continue;

      let item = 0;
      for (let index = 0; index < busWidth; index++) {
        const mapped = dataIndices[index];
        if (mapped !== null && pins[DATA_PIN + mapped] === 1) item |= 1 << index;
      }
      this.handleBits(this.samplenum, item, busWidth);
    }

    this.handleBits(this.samplenum, null, busWidth);
  }
}

export default ParallelDecoder;
