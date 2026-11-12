import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { TpiuCase, TpiuItem } from './generator.js';

export function createEncoder(config: TpiuCase): WaveformEncoder<TpiuItem> {
  const options = config.chain?.[0]?.options ?? {},
    writer = new PackedWaveformWriter(config),
    dataBits = Number(options.data_bits ?? 8),
    stopBits = Number(options.stop_bits ?? 1),
    parity = String(options.parity ?? 'none'),
    msbFirst = options.bit_order === 'msb-first',
    bitWidth = config.sampleRate / Number(options.baudrate ?? 1_000_000),
    lines = (['rx', 'tx'] as const).map((name) => ({
      name,
      bit: config.channels[name]!,
      invert: options[`invert_${name}`] === 'yes' ? 1 : 0,
    }));
  let units = 0,
    samples = 0,
    started = false;
  const packed = (levels: readonly number[]): number =>
    lines.reduce((value, line, index) => value | ((levels[index]! ^ line.invert) << line.bit), 0);
  const idle = packed(lines.map(() => 1));
  function* emit(value: number, duration: number): Iterable<SignalWindow> {
    units += duration;
    const end = Math.round(units * bitWidth);
    yield* writer.write(value, end - samples);
    samples = end;
  }
  function* word(value: number, direction: 'rx' | 'tx'): Iterable<SignalWindow> {
    const level = (bit: number): number => packed(lines.map((line) => (line.name === direction ? bit : 1)));
    yield* emit(level(0), 1);
    for (let index = 0; index < dataBits; index++) {
      const shift = msbFirst ? dataBits - index - 1 : index;
      yield* emit(level((value >>> shift) & 1), 1);
    }
    if (parity !== 'none') {
      let ones = 0;
      for (let index = 0; index < dataBits; index++) ones ^= (value >>> index) & 1;
      const parityLevel =
        parity === 'one' ? 1 : parity === 'zero' || parity === 'ignore' ? 0 : parity === 'odd' ? ones ^ 1 : ones;
      yield* emit(level(parityLevel), 1);
    }
    yield* emit(idle, stopBits);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(idle, 2);
      }
      for (const item of data) {
        yield* emit(idle, item.gapBits ?? 0);
        for (const value of item.bytes) {
          if (!Number.isInteger(value) || value < 0 || value >= 2 ** dataBits)
            throw new RangeError('Invalid TPIU byte');
          yield* word(value, item.direction);
        }
      }
    },
    *finish() {
      yield* emit(idle, 3);
      yield* writer.finish();
    },
  };
}
