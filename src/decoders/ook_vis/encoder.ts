import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { VIS_UNIT, type VisCase, type VisWord } from './generator.js';

function runs(bits: string): Array<{ value: string; count: number }> {
  const items: Array<{ value: string; count: number }> = [];
  for (const bit of bits) {
    const last = items.at(-1);
    if (last?.value === bit) last.count++;
    else items.push({ value: bit, count: 1 });
  }
  return items;
}

export function createEncoder(config: VisCase): WaveformEncoder<VisWord> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.data!;
  function* word(value: VisWord): Iterable<SignalWindow> {
    const first = Number(value.bits[0]);
    yield* writer.write((first ^ 1) << bit, VIS_UNIT);
    for (const run of runs(value.bits)) yield* writer.write(Number(run.value) << bit, run.count * VIS_UNIT);
    yield* writer.write((Number(value.bits.at(-1)) ^ 1) << bit, 6 * VIS_UNIT);
  }
  return {
    *push(data) {
      for (const item of data) yield* word(item);
    },
    *finish() {
      yield* writer.finish();
    },
  };
}
