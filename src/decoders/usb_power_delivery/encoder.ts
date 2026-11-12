import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { buildPdPacket } from './generator.js';
import type { UsbPowerDeliveryCase, UsbPowerDeliveryPacket } from './generator.js';

const UI_US = 1_000_000 / 600_000;

export function createEncoder(config: UsbPowerDeliveryCase): WaveformEncoder<UsbPowerDeliveryPacket> {
  const writer = new PackedWaveformWriter(config);
  const cc1 = config.channels.cc1!;
  const half = Math.trunc((UI_US * config.sampleRate) / 1_000_000);
  if (half < 2) throw new RangeError('USB PD sample rate is too low');
  const period = 2 * half;
  let started = false;
  let level = 0;
  function* emit(samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(level << cc1, samples);
  }
  function* packet(packet: UsbPowerDeliveryPacket): Iterable<SignalWindow> {
    level ^= 1;
    for (const bit of buildPdPacket(packet).bits) {
      if (bit === 0) {
        yield* emit(period);
        level ^= 1;
      } else {
        yield* emit(half);
        level ^= 1;
        yield* emit(half);
        level ^= 1;
      }
    }
    yield* emit(96);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(96);
      }
      for (const item of data) yield* packet(item);
    },
    *finish() {
      if (!started) {
        started = true;
        yield* emit(96);
      }
      level ^= 1;
      yield* emit(24);
      yield* writer.finish();
    },
  };
}
