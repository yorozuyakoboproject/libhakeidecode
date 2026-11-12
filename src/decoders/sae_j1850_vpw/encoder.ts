import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { SaeCase, SaeFrame } from './generator.js';

export const SAE_INITIAL_IDLE_SAMPLES = 2;

export interface SaeTiming {
  readonly sof: number;
  readonly short: number;
  readonly long: number;
  readonly ifs: number;
  readonly idleTail: number;
}

export function saeTiming(sampleRate: number, speed: 1 | 4): SaeTiming {
  const samples = (us: number): number => Math.trunc(us * 1e-6 * sampleRate);
  const ifs = samples(240 / speed);
  return {
    sof: samples(200 / speed),
    short: samples(64 / speed),
    long: samples(128 / speed),
    ifs,
    idleTail: ifs + Math.max(1, samples(4)),
  };
}

export function saeFrameBits(frame: SaeFrame): number[] {
  if (frame.bytes.length < 5) throw new RangeError('SAE J1850 frames require at least five bytes.');
  const bits: number[] = [];
  for (const value of frame.bytes) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff)
      throw new RangeError('SAE J1850 bytes must be integers from 0 through 255.');
    for (let shift = 7; shift >= 0; shift--) bits.push((value >>> shift) & 1);
  }
  return bits;
}

export function createEncoder(config: SaeCase): WaveformEncoder<SaeFrame> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.data;
  if (channel === undefined) throw new RangeError('SAE J1850 encoder requires the data channel.');
  let level = 0;
  let started = false;

  function* write(value: number, samples: number): Iterable<SignalWindow> {
    if (samples < 0) throw new RangeError('SAE J1850 pulse width cannot be negative.');
    if (samples > 0) yield* writer.write(value << channel, samples);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(0, SAE_INITIAL_IDLE_SAMPLES);
      }
      for (const frame of data) {
        const timing = saeTiming(config.sampleRate, frame.speed);
        if (level !== 0) throw new RangeError('SAE J1850 frame must start from an idle-low level.');
        yield* write(1, timing.sof);
        level = 0;
        for (const bit of saeFrameBits(frame)) {
          const width = bit === level ? timing.short : timing.long;
          yield* write(level, width);
          level ^= 1;
        }
        if (level !== 0) throw new RangeError('SAE J1850 frame must contain complete bytes.');
        yield* write(0, timing.idleTail);
      }
    },
    *finish() {
      if (!started) yield* write(0, SAE_INITIAL_IDLE_SAMPLES);
      yield* writer.finish();
    },
  };
}
