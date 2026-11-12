import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { JtagCaptureStep, JtagCase } from './generator.js';

export function createEncoder(config: JtagCase): WaveformEncoder<JtagCaptureStep> {
  const writer = new PackedWaveformWriter(config);
  const tdi = config.channels.tdi;
  const tdo = config.channels.tdo;
  const tck = config.channels.tck;
  const tms = config.channels.tms;
  if (tdi === undefined || tdo === undefined || tck === undefined || tms === undefined)
    throw new Error('JTAG encoder requires TDI, TDO, TCK, and TMS channels');
  let started = false;
  const packed = (clock: number, mode: number, input: number, output: number): number =>
    (clock << tck) | (mode << tms) | (input << tdi) | (output << tdo);
  function* emit(value: number, duration: number): Iterable<SignalWindow> {
    yield* writer.write(value, duration);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(packed(0, 1, 0, 0), 1);
      }
      for (const step of data) {
        yield* emit(packed(0, step.tms, step.tdi, step.tdo), 1);
        yield* emit(packed(1, step.tms, step.tdi, step.tdo), 1);
      }
      yield* writer.finish();
    },
    *finish() {
      yield* emit(packed(0, 1, 0, 0), 1);
      yield* writer.finish();
    },
  };
}
