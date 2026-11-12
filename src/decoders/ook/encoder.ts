import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { OOK_IDLE_SAMPLES, OOK_UNIT_SAMPLES, type OokCase, type OokWord } from './generator.js';

function runs(bits: string): Array<{ value: string; count: number }> {
  const items: Array<{ value: string; count: number }> = [];
  for (const bit of bits) {
    const last = items.at(-1);
    if (last?.value === bit) last.count++;
    else items.push({ value: bit, count: 1 });
  }
  return items;
}

export function createEncoder(config: OokCase): WaveformEncoder<OokWord> {
  const writer = new PackedWaveformWriter(config);
  const dataBit = config.channels.data!;
  let started = false;

  function* word(item: OokWord): Iterable<SignalWindow> {
    const bits = item.bits;
    if (!bits.length) throw new RangeError('OOK word cannot be empty');
    const width = item.bitSamples ?? OOK_UNIT_SAMPLES;
    const idle = (OOK_IDLE_SAMPLES * width) / OOK_UNIT_SAMPLES;
    const first = Number(bits[0]);
    yield* writer.write((first ^ 1) << dataBit, width);
    for (const run of runs(bits)) yield* writer.write(Number(run.value) << dataBit, run.count * width);
    const last = Number(bits.at(-1));
    yield* writer.write((last ^ 1) << dataBit, idle);
  }

  return {
    *push(data) {
      started = true;
      for (const item of data) yield* word(item);
    },
    *finish() {
      if (!started) yield* writer.write(0, OOK_UNIT_SAMPLES);
      yield* writer.finish();
    },
  };
}
