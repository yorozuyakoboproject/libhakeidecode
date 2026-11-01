import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { IRNECCase, IRNECWord } from './generator.js';

export function createEncoder(config: IRNECCase): WaveformEncoder<IRNECWord> {
  const writer = new PackedWaveformWriter(config),
    bit = config.channels.ir!,
    active = config.options.polarity === 'active-high' ? 1 : 0,
    carrier = Number(config.options.carrier_frequency);
  let seconds = 0,
    samples = 0,
    started = false;
  function* emit(next: number, duration: number): Iterable<SignalWindow> {
    seconds += duration;
    const end = Math.round(seconds * config.sampleRate);
    if (end > samples) yield* writer.write(next << bit, end - samples);
    samples = end;
  }
  function* mark(duration: number): Iterable<SignalWindow> {
    if (!(carrier > 0)) {
      yield* emit(active, duration);
      return;
    }
    const endsAt = seconds + duration,
      half = 0.5 / carrier;
    let current = active,
      remaining = duration;
    while (remaining > 0) {
      const slice = Math.min(half, remaining);
      yield* emit(current, slice);
      current ^= 1;
      remaining -= slice;
    }
    if (seconds < endsAt) yield* emit(active ^ 1, endsAt - seconds);
  }
  function* space(duration: number): Iterable<SignalWindow> {
    yield* emit(active ^ 1, duration);
  }
  function* word(value: IRNECWord): Iterable<SignalWindow> {
    yield* mark(9e-3);
    if (value.kind === 'repeat') {
      yield* space(2.25e-3);
      yield* mark(0.56e-3);
    } else {
      yield* space(4.5e-3);
      const address = value.address ?? 0,
        command = value.command ?? 0,
        addressInverse = value.invalid ? (address ^ 0x5a) & 0xff : (address ^ 0xff) & 0xff,
        commandInverse = value.invalid ? (command ^ 0xa5) & 0xff : (command ^ 0xff) & 0xff,
        extended = config.options.extended === 'yes',
        data = extended
          ? [address & 0xff, (address >>> 8) & 0xff, command, commandInverse]
          : [address & 0xff, addressInverse, command, commandInverse];
      for (const byte of data)
        for (let index = 0; index < 8; index++) {
          const one = (byte >>> index) & 1;
          yield* mark(0.56e-3);
          yield* space(one ? 1.69e-3 : 0.56e-3);
        }
      yield* mark(0.56e-3);
    }
    yield* space(config.gapMs > 0 ? config.gapMs * 1e-3 - 0.56e-3 : 1e-3);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(active ^ 1, 2e-3);
      }
      for (const value of data) yield* word(value);
    },
    *finish() {
      yield* emit(active ^ 1, 20e-3);
      yield* writer.finish();
    },
  };
}
