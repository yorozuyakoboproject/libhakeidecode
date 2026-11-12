import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Dcf77Case, Dcf77Slot } from './generator.js';

export function createEncoder(config: Dcf77Case): WaveformEncoder<Dcf77Slot> {
  const writer = new PackedWaveformWriter(config);
  const line = config.channels.data!;
  let elapsedMs = 0;
  let samples = 0;
  let started = false;

  function* emit(level: number, durationMs: number): Iterable<SignalWindow> {
    elapsedMs += durationMs;
    const end = Math.round((elapsedMs * config.sampleRate) / 1000);
    if (end > samples) yield* writer.write(level << line, end - samples);
    samples = end;
  }

  return {
    *push(data) {
      started = true;
      for (const slot of data) {
        if (
          !Number.isFinite(slot.highMs) ||
          !Number.isFinite(slot.periodMs) ||
          slot.highMs < 0 ||
          slot.periodMs < slot.highMs
        )
          throw new RangeError('Invalid DCF77 slot timing');
        if (slot.highMs) yield* emit(1, slot.highMs);
        yield* emit(0, slot.periodMs - slot.highMs);
      }
    },
    *finish() {
      if (!started) yield* emit(0, 1);
      yield* writer.finish();
    },
  };
}
