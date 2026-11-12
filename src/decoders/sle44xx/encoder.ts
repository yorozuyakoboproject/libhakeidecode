import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { Sle44xxCase, Sle44xxItem } from './generator.js';

export function createEncoder(config: Sle44xxCase): WaveformEncoder<Sle44xxItem> {
  const writer = new PackedWaveformWriter(config);
  const rstBit = config.channels.rst;
  const clkBit = config.channels.clk;
  const ioBit = config.channels.io;
  if (rstBit === undefined || clkBit === undefined || ioBit === undefined)
    throw new Error('SLE44xx encoder requires RST, CLK and I/O channels');
  const samples = 2;
  let rst = 0;
  let clk = 0;
  let io = 1;
  let started = false;
  const packed = (): number => (rst << rstBit) | (clk << clkBit) | (io << ioBit);
  function* write(count = samples): Iterable<SignalWindow> {
    if (count > 0) yield* writer.write(packed(), count);
  }

  function* byte(value: number): Iterable<SignalWindow> {
    clk = 0;
    yield* write();
    for (let index = 0; index < 8; index++) {
      io = (value >> index) & 1;
      yield* write();
      clk = 1;
      yield* write();
      clk = 0;
      yield* write();
    }
  }

  return {
    *push(items) {
      if (!started) {
        started = true;
        yield* write();
      }
      for (const item of items) {
        switch (item.kind) {
          case 'levels':
            rst = item.rst;
            clk = item.clk;
            io = item.io;
            yield* write(item.samples ?? samples);
            break;
          case 'reset-clock':
            clk = 0;
            yield* write();
            for (let pulse = 0; pulse < item.pulses; pulse++) {
              clk = 1;
              yield* write();
              clk = 0;
              yield* write();
            }
            break;
          case 'byte':
            yield* byte(item.value);
            break;
          case 'start':
            clk = 0;
            io = 1;
            yield* write();
            clk = 1;
            yield* write();
            io = 0;
            yield* write();
            break;
          case 'stop':
            clk = 0;
            io = 0;
            yield* write();
            clk = 1;
            yield* write();
            io = 1;
            yield* write();
            break;
          case 'process':
            clk = 0;
            io = 0;
            yield* write();
            for (let pulse = 0; pulse < item.clocks; pulse++) {
              clk = 1;
              yield* write();
              clk = 0;
              yield* write();
            }
            clk = 1;
            yield* write();
            io = 1;
            yield* write();
            break;
        }
      }
    },
    *finish() {
      if (!started) yield* write();
      yield* writer.finish();
    },
  };
}
