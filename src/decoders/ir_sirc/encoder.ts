import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { SIRC_GAP_SAMPLES, SIRC_LEAD_SAMPLES, sircTiming, type SircCase } from './generator.js';
import { sircFrameBits, type SircFrame } from './index.js';

export function createEncoder(config: SircCase): WaveformEncoder<SircFrame> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.ir!;
  const timing = sircTiming(config.sampleRate);
  const invert = config.options.polarity === 'active-high';
  const idle = 1;
  const active = idle ^ 1;
  let started = false;

  function* write(level: number, samples: number): Iterable<SignalWindow> {
    yield* writer.write((invert ? level ^ 1 : level) << channel, samples);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(idle, SIRC_LEAD_SAMPLES);
      }
      for (const frame of data) {
        yield* write(active, timing.agc);
        yield* write(idle, timing.pause);
        for (const bit of sircFrameBits(frame)) {
          yield* write(active, bit ? timing.one : timing.zero);
          yield* write(idle, timing.pause);
        }
        yield* write(idle, SIRC_GAP_SAMPLES);
      }
    },
    *finish() {
      yield* write(idle, SIRC_GAP_SAMPLES);
      yield* writer.finish();
    },
  };
}
