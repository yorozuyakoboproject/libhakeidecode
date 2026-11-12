import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { LpcCase, LpcStep } from './generator.js';

export function createEncoder(config: LpcCase): WaveformEncoder<LpcStep> {
  const writer = new PackedWaveformWriter(config);
  const frameBit = config.channels.lframe;
  const clockBit = config.channels.lclk;
  const ladBits = [config.channels.lad0, config.channels.lad1, config.channels.lad2, config.channels.lad3];
  if (frameBit === undefined || clockBit === undefined || ladBits.some((bit) => bit === undefined))
    throw new Error('LPC encoder requires LFRAME, LCLK, and four LAD channels');
  let frame = 1;
  let lad = 0xf;
  let started = false;

  const packed = (clock: 0 | 1): number => {
    let value = (frame << frameBit) | (clock << clockBit);
    for (let bit = 0; bit < 4; bit++) value |= ((lad >>> bit) & 1) << ladBits[bit]!;
    return value;
  };

  function* write(clock: 0 | 1, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(packed(clock), samples);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(0, 2);
      }
      for (const step of data) {
        yield* write(0, 1);
        frame = step.frame;
        lad = step.lad;
        yield* write(1, 1);
      }
    },
    *finish() {
      if (!started) yield* write(0, 2);
      yield* write(0, 1);
      yield* writer.finish();
    },
  };
}
