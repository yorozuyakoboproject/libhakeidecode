import { DecodeError } from './errors.js';
import type { ChannelId, ChannelMapping, LogicLevel, LogicWindow, Pin, SignalWindow } from './types.js';
import type { SampleChunk } from '../libhakei/index.js';

function valueAt(data: ArrayLike<number>, index: number): Pin {
  const value = data[index];
  return value === 0 || value === 1 ? (value as LogicLevel) : 255;
}

export class ValuesLogicWindow implements LogicWindow {
  readonly kind = 'values';
  readonly data: ArrayLike<number>;
  readonly length: number;
  constructor(data: ArrayLike<number>) {
    this.data = data;
    this.length = data.length;
  }
  at(index: number): Pin {
    return valueAt(this.data, index);
  }
  nextEdge(index: number, limit = this.length): number {
    let cursor = Math.max(1, index);
    const end = limit < this.length ? limit : this.length;
    if (cursor >= end) return end;
    const data = this.data,
      rawPrev = data[cursor - 1],
      previous = rawPrev === 0 || rawPrev === 1 ? rawPrev : 255;
    for (; cursor < end; cursor++) {
      const raw = data[cursor];
      if (raw === rawPrev) continue;
      const current = raw === 0 || raw === 1 ? raw : 255;
      if (current !== previous) return cursor;
    }
    return end;
  }
}

export class PackedLogicWindow implements LogicWindow {
  readonly kind = 'packed';
  readonly data: Uint8Array;
  readonly bit: number;
  readonly length: number;
  readonly sampleBytes: number;
  private words32: Uint32Array | null | undefined = undefined;
  private wordHead = 0;
  constructor(data: Uint8Array, bit: number, sampleBytes = 1) {
    if (!Number.isInteger(bit) || bit < 0 || bit >= sampleBytes * 8)
      throw new DecodeError('Packed logic bit is outside the sample width.');
    if (![1, 2, 3, 4].includes(sampleBytes) || data.length % sampleBytes)
      throw new DecodeError('Packed logic data does not contain whole samples.');
    this.data = data;
    this.bit = bit;
    this.sampleBytes = sampleBytes;
    this.length = data.length / sampleBytes;
  }
  at(index: number): Pin {
    const bytePos = index * this.sampleBytes + (this.bit >> 3);
    return ((this.data[bytePos]! >>> (this.bit & 7)) & 1) as LogicLevel;
  }
  private ensureWords32(): Uint32Array | null {
    if (this.words32 !== undefined) return this.words32;
    if (this.sampleBytes !== 1 || this.data.length < 16) return (this.words32 = null);
    const head = (4 - (this.data.byteOffset & 3)) & 3;
    const wordCount = this.data.byteLength > head ? (this.data.byteLength - head) >>> 2 : 0;
    this.wordHead = head;
    return (this.words32 =
      wordCount > 0 ? new Uint32Array(this.data.buffer, this.data.byteOffset + head, wordCount) : null);
  }
  nextEdge(index: number, limit = this.length): number {
    let cursor = Math.max(1, index);
    const end = limit < this.length ? limit : this.length;
    if (cursor >= end) return end;
    const data = this.data,
      sampleBytes = this.sampleBytes,
      bitByte = this.bit >> 3,
      bitMask = 1 << (this.bit & 7),
      prevMasked = data[(cursor - 1) * sampleBytes + bitByte]! & bitMask;
    if (sampleBytes === 1) {
      if (end - cursor >= 16) {
        const words = this.ensureWords32();
        if (words) {
          const head = this.wordHead;
          const alignStop =
            cursor < head ? Math.min(end, head) : Math.min(end, cursor + ((4 - ((cursor - head) & 3)) & 3));
          while (cursor < alignStop) {
            if ((data[cursor]! & bitMask) !== prevMasked) return cursor;
            cursor++;
          }
          if (cursor >= head && cursor + 4 <= end) {
            const mask4 = (bitMask * 0x01010101) >>> 0;
            const target4 = prevMasked ? mask4 : 0;
            let wordIdx = (cursor - head) >>> 2;
            const wordStop = Math.min(words.length, (end - head) >>> 2);
            while (wordIdx < wordStop && (words[wordIdx]! & mask4) >>> 0 === target4) wordIdx++;
            cursor = head + (wordIdx << 2);
          }
        }
      }
      while (cursor < end) {
        if ((data[cursor]! & bitMask) !== prevMasked) return cursor;
        cursor++;
      }
      return end;
    }
    for (let bytePos = cursor * sampleBytes + bitByte; cursor < end; cursor++, bytePos += sampleBytes) {
      if ((data[bytePos]! & bitMask) !== prevMasked) return cursor;
    }
    return end;
  }
}

export class EdgesLogicWindow implements LogicWindow {
  readonly kind = 'edges';
  readonly initial: LogicLevel;
  readonly edges: readonly (number | bigint)[];
  readonly length: number;
  private readonly positions: number[];
  constructor(initial: LogicLevel, edges: readonly (number | bigint)[], length: number, startSample?: bigint) {
    if (initial !== 0 && initial !== 1) throw new DecodeError('Edge window initial level must be 0 or 1.');
    this.initial = initial;
    this.edges = edges;
    this.length = length;
    this.positions = edges
      .map((edge) => {
        if (typeof edge === 'number' && (!Number.isSafeInteger(edge) || edge < 0))
          throw new DecodeError('Invalid edge position.');
        const position = BigInt(edge) - (startSample ?? 0n);
        if (position > BigInt(Number.MAX_SAFE_INTEGER))
          throw new DecodeError('Edge position is outside the local window.');
        return Number(position);
      })
      .filter((position) => startSample === undefined || position > 0);
  }
  at(index: number): Pin {
    let low = 0,
      high = this.positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.positions[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    return (this.initial ^ (low & 1)) as LogicLevel;
  }
  nextEdge(index: number, limit = this.length): number {
    const end = limit < this.length ? limit : this.length;
    let low = 0,
      high = this.positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.positions[middle]! < index) low = middle + 1;
      else high = middle;
    }
    if (low >= this.positions.length) return end;
    const pos = this.positions[low]!;
    return pos < end ? pos : end;
  }
}

class Window implements SignalWindow {
  readonly startSample: bigint;
  readonly endSample: bigint;
  readonly sampleRate: number;
  readonly length: number;
  readonly channelIds: readonly string[];
  private readonly windows: ReadonlyMap<string, LogicWindow>;
  constructor(startSample: bigint, endSample: bigint, sampleRate: number, channels: ReadonlyMap<string, LogicWindow>) {
    if (startSample < 0n || endSample < startSample) throw new DecodeError('Invalid signal window interval.');
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 1)
      throw new DecodeError('Sample rate must be a positive safe integer.');
    this.startSample = startSample;
    this.endSample = endSample;
    this.sampleRate = sampleRate;
    this.length = Number(endSample - startSample);
    this.channelIds = [...channels.keys()];
    this.windows = channels;
  }
  channel(id: ChannelId): LogicWindow | undefined {
    return this.windows.get(String(id));
  }
}

export function createSignalWindow({
  startSample,
  endSample,
  sampleRate,
  channels,
}: {
  startSample: bigint;
  endSample: bigint;
  sampleRate: number;
  channels: Readonly<Record<string, LogicWindow>>;
}): SignalWindow {
  const entries = Object.entries(channels);
  if (!entries.length) throw new DecodeError('A signal window requires at least one channel.');
  const length = Number(endSample - startSample);
  for (const [id, view] of entries)
    if (view.length !== length) throw new DecodeError(`Window channel ${id} has the wrong length.`);
  return new Window(startSample, endSample, sampleRate, new Map(entries));
}

export function createValuesWindow(
  startSample: bigint,
  sampleRate: number,
  channels: Readonly<Record<string, ArrayLike<number>>>,
): SignalWindow {
  const views = Object.fromEntries(Object.entries(channels).map(([id, data]) => [id, new ValuesLogicWindow(data)]));
  const length = Object.values(views)[0]?.length ?? 0;
  return createSignalWindow({ startSample, endSample: startSample + BigInt(length), sampleRate, channels: views });
}

export function createPackedWindow(
  startSample: bigint,
  sampleRate: number,
  data: Uint8Array,
  channels: Readonly<Record<string, number>>,
  sampleBytes = 1,
): SignalWindow {
  const views = Object.fromEntries(
    Object.entries(channels).map(([id, bit]) => [id, new PackedLogicWindow(data, bit, sampleBytes)]),
  );
  return createSignalWindow({
    startSample,
    endSample: startSample + BigInt(data.length / sampleBytes),
    sampleRate,
    channels: views,
  });
}

export function createEdgeWindow(
  startSample: bigint,
  endSample: bigint,
  sampleRate: number,
  initial: LogicLevel,
  edges: readonly (number | bigint)[],
  id = 'data',
): SignalWindow {
  const length = Number(endSample - startSample);
  return createSignalWindow({
    startSample,
    endSample,
    sampleRate,
    channels: { [id]: new EdgesLogicWindow(initial, edges, length, startSample) },
  });
}

export function createEdgesWindow(
  startSample: bigint,
  endSample: bigint,
  sampleRate: number,
  channels: Readonly<Record<string, { initial: LogicLevel; edges: readonly bigint[] }>>,
): SignalWindow {
  const length = Number(endSample - startSample);
  return createSignalWindow({
    startSample,
    endSample,
    sampleRate,
    channels: Object.fromEntries(
      Object.entries(channels).map(([id, channel]) => [
        id,
        new EdgesLogicWindow(channel.initial, channel.edges, length, startSample),
      ]),
    ),
  });
}

export function createChunkSignalWindow(chunk: SampleChunk, channels: ChannelMapping): SignalWindow {
  const views: Record<string, LogicWindow> = {};
  for (const [id, mapped] of Object.entries(channels)) {
    if (mapped == null || mapped === false || mapped === -1) continue;
    const key = mapped === true ? id : String(mapped);
    const data = chunk.channels[key];
    if (data) views[id] = new ValuesLogicWindow(data);
  }
  return createSignalWindow({
    startSample: chunk.startSample,
    endSample: chunk.endSample,
    sampleRate: chunk.sampleRate,
    channels: views,
  });
}

export function materializeLogicWindow(window: LogicWindow): ArrayLike<number> {
  if (window.kind === 'values' && window.data && (ArrayBuffer.isView(window.data) || Array.isArray(window.data)))
    return window.data;
  const output = new Uint8Array(window.length);
  if (window.kind === 'packed' && window.data) {
    for (let index = 0; index < output.length; index++) output[index] = window.at(index) as LogicLevel;
  } else if (window.kind === 'edges') {
    for (let index = 0; index < output.length;) {
      const next = Math.min(output.length, Math.max(index + 1, window.nextEdge(index + 1)));
      output.fill(window.at(index), index, next);
      index = next;
    }
  } else {
    for (let index = 0; index < output.length; index++) output[index] = window.at(index) as LogicLevel;
  }
  return output;
}
