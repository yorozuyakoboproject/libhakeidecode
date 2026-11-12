import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { MillerCase, MillerRun } from './generator.js';

export function markerIntervals(bits: readonly number[]): number[] {
  const intervals: number[] = [];
  let state = 0;
  let index = 0;
  while (index < bits.length) {
    const bit = bits[index]!;
    if (bit !== 0 && bit !== 1) throw new RangeError('Miller payload bits must be 0 or 1.');
    if (state === 0) {
      intervals.push(bit === 0 ? 1 : 1.5);
      state = bit;
      index++;
      continue;
    }
    if (bit === 1) {
      intervals.push(1);
      index++;
      continue;
    }
    const next = bits[index + 1];
    if (next === 0) {
      intervals.push(1.5);
      state = 0;
      index += 2;
    } else if (next === 1) {
      intervals.push(2);
      index += 2;
    } else {
      throw new RangeError('Miller payload must end in the space state.');
    }
  }
  if (state !== 0) throw new RangeError('Miller payload must end in the space state.');
  return intervals;
}

export function markerSamples(intervals: readonly number[], unitSamples: number): number[] {
  const samples = [0];
  let units = 0;
  for (const interval of intervals) {
    units += interval;
    samples.push(Math.round(units * unitSamples));
  }
  for (let index = 1; index < samples.length; index++)
    if (samples[index]! <= samples[index - 1]!) throw new RangeError('Miller markers are not representable.');
  return samples;
}

export function tailSamples(edge: string, unitSamples: number): number {
  const timeout = Math.trunc(3 * unitSamples);
  return edge === 'either' ? timeout + 1 : timeout + 2;
}

export function createEncoder(config: MillerCase): WaveformEncoder<MillerRun> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.data!;
  const unitSamples = config.sampleRate / Number(config.options.baudrate);
  if (!(unitSamples > 0) || !Number.isFinite(unitSamples))
    throw new RangeError('Miller sample rate and baud rate are not representable.');
  const edge = String(config.options.edge);
  if (edge !== 'rising' && edge !== 'falling' && edge !== 'either')
    throw new RangeError('Miller edge must be rising, falling, or either.');
  const idle = edge === 'falling' ? 1 : 0;
  const active = idle ^ 1;
  let level = idle;
  let started = false;

  function* write(value: number, samples: number): Iterable<SignalWindow> {
    if (samples < 0) throw new RangeError('Miller waveform duration cannot be negative.');
    if (samples > 0) yield* writer.write(value << bit, samples);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(level, 1);
      }
      for (const run of data) {
        const intervals = markerIntervals(run.bits);
        if (run.malformed) intervals.push(0.5);
        const markers = markerSamples(intervals, unitSamples);
        if (edge === 'either') {
          for (let index = 0; index < markers.length; index++) {
            level ^= 1;
            const hold =
              index + 1 < markers.length ? markers[index + 1]! - markers[index]! : tailSamples(edge, unitSamples);
            yield* write(level, hold);
          }
          continue;
        }
        for (let index = 0; index < markers.length; index++) {
          if (index > 0) {
            const gap = markers[index]! - markers[index - 1]! - 1;
            if (gap < 1) throw new RangeError('Miller selected-edge pulses overlap.');
            yield* write(idle, gap);
          }
          yield* write(active, 1);
        }
        yield* write(idle, tailSamples(edge, unitSamples) - 1);
      }
    },
    *finish() {
      yield* writer.finish();
    },
  };
}
