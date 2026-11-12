import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { MapleCase, MapleFrame } from './generator.js';

export function createEncoder(config: MapleCase): WaveformEncoder<MapleFrame> {
  const writer = new PackedWaveformWriter(config);
  const a = config.channels.sdcka;
  const b = config.channels.sdckb;
  if (a === undefined || b === undefined) throw new Error('Maple bus encoder requires SDCKA and SDCKB channels');
  let started = false;

  const packed = (sdcka: number, sdckb: number): number => (sdcka << a) | (sdckb << b);

  function* write(sdcka: number, sdckb: number): Iterable<SignalWindow> {
    yield* writer.write(packed(sdcka, sdckb), 1);
  }

  function* start(pulses: 4 | 6): Iterable<SignalWindow> {
    yield* write(0, 1);
    for (let index = 0; index < pulses; index++) {
      yield* write(0, 0);
      yield* write(0, 1);
    }
    yield* write(1, 1);
  }

  function* byte(value: number): Iterable<SignalWindow> {
    yield* write(1, 1);
    yield* write(1, 0);
    for (let index = 0; index < 8; index++) {
      const bit = (value >>> (7 - index)) & 1;
      if (index % 2 === 0) {
        yield* write(1, bit);
        yield* write(0, bit);
      } else {
        yield* write(bit, 1);
        yield* write(bit, 0);
      }
    }
    yield* write(1, 0);
  }

  function* end(): Iterable<SignalWindow> {
    yield* write(1, 1);
    yield* write(1, 0);
    yield* write(1, 0);
    yield* write(0, 0);
    yield* write(1, 0);
    yield* write(0, 0);
    yield* write(1, 1);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(1, 1);
      }
      for (const frame of data) {
        yield* start(frame.startPulses);
        for (const value of frame.bytes) yield* byte(value);
        yield* end();
      }
    },
    *finish() {
      if (!started) yield* write(1, 1);
      yield* write(1, 1);
      yield* writer.finish();
    },
  };
}
