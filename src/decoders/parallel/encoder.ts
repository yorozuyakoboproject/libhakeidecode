import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import { createSignalWindow } from '../../libhakeidecode/signal.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { ParallelCase, ParallelItem } from './generator.js';

export function createEncoder(config: ParallelCase): WaveformEncoder<ParallelItem> {
  if (!Number.isSafeInteger(config.initialSamples) || config.initialSamples < 1)
    throw new RangeError('Parallel initial sample count must be positive');
  const mappings = Object.entries(config.channels).map(([id, bit]) => [id, bit] as const);
  if (!mappings.length) throw new Error('Parallel encoder requires at least one channel');
  let data = config.initialData;
  let clk = config.initialClk;
  let rst = config.initialRst;
  let started = false;

  const groups = Array.from({ length: Math.ceil(mappings.length / 8) }, (_, group) => {
    const entries = mappings.slice(group * 8, group * 8 + 8);
    return {
      entries,
      writer: new PackedWaveformWriter({
        ...config,
        channels: Object.fromEntries(entries.map(([id], index) => [id, index])),
      }),
    };
  });
  const level = (id: string): number => {
    if (id === 'clk') return clk;
    if (id === 'rst') return rst;
    return (data >>> Number(id.slice(1))) & 1;
  };
  const packed = (entries: readonly (readonly [string, number])[]): number =>
    entries.reduce((word, [id], index) => word | (level(id) << index), 0);
  function* write(samples: number): Iterable<SignalWindow> {
    const iterators = groups.map((group) => group.writer.write(packed(group.entries), samples)[Symbol.iterator]());
    while (true) {
      const first = iterators[0]!.next();
      if (first.done) break;
      const windows = [first.value];
      for (const iterator of iterators.slice(1)) {
        const next = iterator.next();
        if (next.done) throw new Error('Parallel packed writers fell out of sync');
        windows.push(next.value);
      }
      yield mergeWindows(windows);
    }
    for (const iterator of iterators) {
      if (!iterator.next().done) throw new Error('Parallel packed writers fell out of sync');
    }
  }
  return {
    *push(items) {
      if (!items.length) return;
      if (!started) {
        started = true;
        yield* write(config.initialSamples);
      }
      for (const item of items) {
        if (!Number.isSafeInteger(item.hold) || item.hold < 1)
          throw new RangeError('Parallel hold length must be a positive integer');
        if (item.data === data && item.clk === clk && item.rst === rst)
          throw new RangeError('Parallel item has no edge');
        data = item.data;
        clk = item.clk;
        rst = item.rst;
        yield* write(item.hold);
      }
    },
    *finish() {
      if (!started) yield* write(config.initialSamples);
      const iterators = groups.map((group) => group.writer.finish()[Symbol.iterator]());
      while (true) {
        const first = iterators[0]!.next();
        if (first.done) break;
        const windows = [first.value];
        for (const iterator of iterators.slice(1)) {
          const next = iterator.next();
          if (next.done) throw new Error('Parallel packed writers fell out of sync');
          windows.push(next.value);
        }
        yield mergeWindows(windows);
      }
    },
  };
}

function mergeWindows(windows: readonly SignalWindow[]): SignalWindow {
  const first = windows[0]!;
  const channels = Object.fromEntries(
    windows.flatMap((window) => window.channelIds.map((id) => [id, window.channel(id)!] as const)),
  );
  return createSignalWindow({
    startSample: first.startSample,
    endSample: first.endSample,
    sampleRate: first.sampleRate,
    channels,
  });
}
