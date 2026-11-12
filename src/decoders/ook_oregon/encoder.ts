import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { OregonCase, OregonWord } from './generator.js';

const UNIT = 8;

function runs(bits: string): Array<{ value: string; count: number }> {
  const items: Array<{ value: string; count: number }> = [];
  for (const bit of bits) {
    const last = items.at(-1);
    if (last?.value === bit) last.count++;
    else items.push({ value: bit, count: 1 });
  }
  return items;
}

export function createEncoder(config: OregonCase): WaveformEncoder<OregonWord> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.data!;
  function* run(value: number, count: number): Iterable<SignalWindow> {
    while (count > 0) {
      const chunk = Math.min(count, 4);
      yield* writer.write(value << bit, chunk * UNIT);
      count -= chunk;
      if (count > 0) yield* writer.write((value ^ 1) << bit, 1);
    }
  }
  function* word(value: OregonWord): Iterable<SignalWindow> {
    yield* writer.write((Number(value.bits[0]) ^ 1) << bit, UNIT);
    for (const item of runs(value.bits)) yield* run(Number(item.value), item.count);
    yield* writer.write((Number(value.bits.at(-1)) ^ 1) << bit, 6 * UNIT);
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
