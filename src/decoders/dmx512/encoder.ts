import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import {
  DMX_BREAK_BITS,
  DMX_FRAME_BITS,
  DMX_IDLE_BITS,
  DMX_LEAD_BITS,
  DMX_MAB_BITS,
  dmxBitWidth,
  type DmxCase,
  type DmxPacket,
} from './generator.js';

export function createEncoder(config: DmxCase): WaveformEncoder<DmxPacket> {
  const writer = new PackedWaveformWriter(config);
  const line = config.channels.rx!;
  const bitWidth = dmxBitWidth(config);
  let units = 0;
  let samples = 0;
  let started = false;

  function* emit(level: number, bits: number): Iterable<SignalWindow> {
    units += bits;
    const end = Math.round(units * bitWidth);
    if (end > samples) yield* writer.write(level << line, end - samples);
    samples = end;
  }

  function* byte(value: number): Iterable<SignalWindow> {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError('Invalid DMX byte');
    yield* emit(0, 1);
    for (let bit = 0; bit < 8; bit++) yield* emit((value >>> bit) & 1, 1);
    yield* emit(1, 2);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(1, DMX_LEAD_BITS);
      }
      for (const packet of data) {
        const breakBits = packet.breakBits ?? DMX_BREAK_BITS;
        const mabBits = packet.mabBits ?? DMX_MAB_BITS;
        const idleBits = packet.idleBits ?? DMX_IDLE_BITS;
        if (breakBits < DMX_FRAME_BITS) throw new RangeError('DMX BREAK is too short for UART detection');
        if (mabBits < 1) throw new RangeError('DMX MARK after BREAK is too short');
        yield* emit(0, breakBits);
        yield* emit(1, mabBits);
        for (const value of packet.bytes) yield* byte(value);
        yield* emit(1, idleBits);
      }
    },
    *finish() {
      if (!started) yield* emit(1, DMX_LEAD_BITS);
      yield* emit(0, DMX_BREAK_BITS);
      yield* emit(1, 2);
      yield* writer.finish();
    },
  };
}
