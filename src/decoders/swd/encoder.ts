import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SwdCase, SwdStep } from './generator.js';

export function createEncoder(config: SwdCase): WaveformEncoder<SwdStep> {
  const writer = new PackedWaveformWriter(config);
  const swclk = config.channels.swclk;
  const swdio = config.channels.swdio;
  if (swclk === undefined || swdio === undefined) throw new Error('SWD encoder requires SWCLK and SWDIO channels');
  let started = false;
  const packed = (clock: number, dio: number): number => (clock << swclk) | (dio << swdio);
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* writer.write(packed(0, 0), 1);
      }
      for (const step of data) yield* writer.write(packed(step.swclk, step.swdio), 1);
      yield* writer.finish();
    },
    *finish() {
      yield* writer.write(packed(0, 0), 1);
      yield* writer.finish();
    },
  };
}
