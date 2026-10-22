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
  nextEdge(index: number): number {
    let cursor = Math.max(1, index);
    if (cursor >= this.length) return this.length;
    let previous = valueAt(this.data, cursor - 1);
    for (; cursor < this.length; cursor++) {
      const current = valueAt(this.data, cursor);
      if (current !== previous) return cursor;
      previous = current;
    }
    return this.length;
  }
}

export class PackedLogicWindow implements LogicWindow {
  readonly kind = 'packed';
  readonly data: Uint8Array;
  readonly bit: number;
  readonly length: number;
  constructor(data: Uint8Array, bit: number) {
    if (!Number.isInteger(bit) || bit < 0 || bit > 7) throw new DecodeError('Packed logic bit must be in 0..7.');
    this.data = data;
    this.bit = bit;
    this.length = data.length;
  }
  at(index: number): Pin {
    return ((this.data[index]! >>> this.bit) & 1) as LogicLevel;
  }
  nextEdge(index: number): number {
    let cursor = Math.max(1, index);
    if (cursor >= this.length) return this.length;
    let previous = this.at(cursor - 1) as LogicLevel;
    while (cursor < this.length) {
      const next = this.at(cursor);
      if (next !== previous) return cursor;
      previous = next;
      cursor++;
    }
    return this.length;
  }
}

export class EdgesLogicWindow implements LogicWindow {
  readonly kind = 'edges';
  readonly initial: LogicLevel;
  readonly edges: readonly (number | bigint)[];
  readonly length: number;
  private readonly positions: number[];
  constructor(initial: LogicLevel, edges: readonly (number | bigint)[], length: number) {
    if (initial !== 0 && initial !== 1) throw new DecodeError('Edge window initial level must be 0 or 1.');
    this.initial = initial;
    this.edges = edges;
    this.length = length;
    this.positions = edges.map((edge) => {
      if (typeof edge === 'bigint') {
        if (edge < 0n || edge > BigInt(Number.MAX_SAFE_INTEGER))
          throw new DecodeError('Edge position is outside the local window.');
        return Number(edge);
      }
      if (!Number.isSafeInteger(edge) || edge < 0) throw new DecodeError('Edge position is outside the local window.');
      return edge;
    });
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
  nextEdge(index: number): number {
    let low = 0,
      high = this.positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.positions[middle]! < index) low = middle + 1;
      else high = middle;
    }
    return low < this.positions.length ? this.positions[low]! : this.length;
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
): SignalWindow {
  const views = Object.fromEntries(Object.entries(channels).map(([id, bit]) => [id, new PackedLogicWindow(data, bit)]));
  return createSignalWindow({ startSample, endSample: startSample + BigInt(data.length), sampleRate, channels: views });
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
    channels: { [id]: new EdgesLogicWindow(initial, edges, length) },
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
    const bit = window.bit!;
    for (let index = 0; index < output.length; index++) output[index] = (window.data[index]! >>> bit) & 1;
  } else if (window.kind === 'edges') {
    let level = window.initial ?? 0,
      edge = 0;
    const edges = window.edges ?? [];
    for (let index = 0; index < output.length; index++) {
      while (edge < edges.length && Number(edges[edge]!) <= index) {
        level ^= 1;
        edge++;
      }
      output[index] = level;
    }
  } else {
    for (let index = 0; index < output.length; index++) output[index] = window.at(index) as LogicLevel;
  }
  return output;
}
