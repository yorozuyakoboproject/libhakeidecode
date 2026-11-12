import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { RoundtripCase } from '../../build/roundtrip.js';
import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import { SPDIF_PREAMBLE_PULSES, SPDIF_UNIT_SAMPLES, type SpdifSubframe } from './generator.js';

const PRELUDE = [2, 1, 3, 2, 1, 2] as const;

export function createEncoder(config: RoundtripCase<SpdifSubframe>): WaveformEncoder<SpdifSubframe> {
  const writer = new PackedWaveformWriter(config);
  const dataBit = config.channels.data!;
  let level = 0;
  let started = false;

  function* pulse(units: number): Iterable<SignalWindow> {
    yield* writer.write(level << dataBit, units * SPDIF_UNIT_SAMPLES);
    level ^= 1;
  }

  function* preamble(type: SpdifSubframe['preamble']): Iterable<SignalWindow> {
    for (const pulseType of SPDIF_PREAMBLE_PULSES[type]) yield* pulse(pulseType === 2 ? 3 : pulseType === 0 ? 2 : 1);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        for (const units of PRELUDE) yield* pulse(units);
      }
      for (const subframe of data) {
        if (subframe.bits.length !== 28 || subframe.bits.some((bit) => bit !== 0 && bit !== 1))
          throw new RangeError('S/PDIF subframe requires 28 binary samples');
        yield* preamble(subframe.preamble);
        for (const bit of subframe.bits) {
          if (bit === 0) yield* pulse(2);
          else {
            yield* pulse(1);
            yield* pulse(1);
          }
        }
      }
    },
    *finish() {
      if (started) {
        yield* writer.write(level << dataBit, 1);
        level ^= 1;
      }
      yield* writer.finish();
    },
  };
}
