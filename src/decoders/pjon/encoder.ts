import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { PjonCase, PjonPacket } from './generator.js';

const PAD_SAMPLES = 60;
const DATA_SAMPLES = 26;

export function createEncoder(config: PjonCase): WaveformEncoder<PjonPacket> {
  const writer = new PackedWaveformWriter(config);
  let started = false;
  function* sync(): Iterable<SignalWindow> {
    yield* writer.write(1, PAD_SAMPLES);
    yield* writer.write(0, DATA_SAMPLES);
  }
  return {
    *push(packets): Iterable<SignalWindow> {
      if (!started) {
        started = true;
        yield* writer.write(0, config.initialSamples);
      }
      for (const packet of packets) {
        if (!packet.bytes.length || packet.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff))
          throw new RangeError('PJON packets require at least one byte in the range 0..255');
        for (let index = 0; index < 3; index++) yield* sync();
        for (const byte of packet.bytes) {
          yield* sync();
          for (let bit = 0; bit < 8; bit++) yield* writer.write((byte >>> bit) & 1, DATA_SAMPLES);
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
