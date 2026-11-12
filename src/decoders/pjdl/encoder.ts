import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { PJDL_DATA_SAMPLES, PJDL_PAD_SAMPLES } from './generator.js';
import type { PjdlCase, PjdlFrame } from './generator.js';

export function createEncoder(config: PjdlCase): WaveformEncoder<PjdlFrame> {
  const writer = new PackedWaveformWriter(config);
  let started = false;
  function* sync(): Iterable<SignalWindow> {
    yield* writer.write(1, PJDL_PAD_SAMPLES);
    yield* writer.write(0, PJDL_DATA_SAMPLES);
  }
  return {
    *push(frames): Iterable<SignalWindow> {
      if (!started) {
        started = true;
        yield* writer.write(0, config.initialSamples);
      }
      for (const frame of frames) {
        if (!frame.bytes.length || frame.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff))
          throw new RangeError('PJDL frames require at least one byte in the range 0..255');
        for (let index = 0; index < 3; index++) yield* sync();
        for (const byte of frame.bytes) {
          yield* sync();
          for (let bit = 0; bit < 8; bit++) yield* writer.write((byte >>> bit) & 1, PJDL_DATA_SAMPLES);
        }
        yield* writer.write(0, config.idleSamples);
      }
    },
    *finish(): Iterable<SignalWindow> {
      if (!started) yield* writer.write(0, config.initialSamples);
      yield* writer.finish();
    },
  };
}
