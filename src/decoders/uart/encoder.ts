import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { UARTCase, UARTWords } from './generator.js';

export function createEncoder(config: UARTCase): WaveformEncoder<UARTWords> {
  const writer = new PackedWaveformWriter(config);
  const bits = Number(config.options.data_bits),
    stopBits = Number(config.options.stop_bits);
  const parity = String(config.options.parity),
    msb = config.options.bit_order === 'msb-first';
  const width = config.sampleRate / Number(config.options.baudrate);
  const lines = Object.entries(config.channels).map(([name, bit]) => ({
    name: name as 'rx' | 'tx',
    bit,
    invert: config.options['invert_' + name] === 'yes' ? 1 : 0,
  }));
  let units = 0,
    samples = 0,
    started = false;
  const packed = (levels: readonly number[]): number =>
    lines.reduce((value, line, index) => value | ((levels[index]! ^ line.invert) << line.bit), 0);
  const idle = packed(lines.map(() => 1));
  function* emit(value: number, duration: number): Iterable<SignalWindow> {
    units += duration;
    const end = Math.round(units * width);
    yield* writer.write(value, end - samples);
    samples = end;
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(idle, 2);
      }
      for (const words of data) {
        const values = lines.map((line) => {
          const value = words[line.name];
          if (!Number.isInteger(value) || value! < 0 || value! >= 2 ** bits) throw new RangeError('Invalid UART word');
          return value!;
        });
        yield* emit(packed(lines.map(() => 0)), 1);
        for (let bit = 0; bit < bits; bit++)
          yield* emit(packed(values.map((value) => (value >>> (msb ? bits - bit - 1 : bit)) & 1)), 1);
        if (parity !== 'none') {
          const levels = values.map((value) => {
            if (parity === 'one') return 1;
            if (parity === 'zero' || parity === 'ignore') return 0;
            let odd = 0;
            for (let bit = 0; bit < bits; bit++) odd ^= (value >>> bit) & 1;
            return parity === 'odd' ? odd ^ 1 : odd;
          });
          yield* emit(packed(levels), 1);
        }
        yield* emit(idle, stopBits + config.idleBits);
      }
    },
    *finish() {
      yield* emit(idle, 3);
      yield* writer.finish();
    },
  };
}
