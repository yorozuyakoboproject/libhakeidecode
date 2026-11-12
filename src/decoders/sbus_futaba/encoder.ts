import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { SbusCase, SbusMessage } from './generator.js';

const WITHIN_GAP = 1;
const BETWEEN_GAP = 12;

export function createEncoder(config: SbusCase): WaveformEncoder<SbusMessage> {
  const uart = config.chain?.[0]?.options ?? {},
    writer = new PackedWaveformWriter(config),
    dataBits = Number(uart.data_bits ?? 8),
    stopBits = Number(uart.stop_bits ?? 2),
    parity = String(uart.parity ?? 'even'),
    msb = uart.bit_order === 'msb-first',
    width = config.sampleRate / Number(uart.baudrate ?? 100000),
    lines = Object.entries(config.channels).map(([name, bit]) => ({
      name: name as 'rx' | 'tx',
      bit,
      invert: uart['invert_' + name] === 'yes' ? 1 : 0,
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
  function* byte(value: number, active: 'rx' | 'tx'): Iterable<SignalWindow> {
    yield* emit(packed(lines.map((line) => (line.name === active ? 0 : 1))), 1);
    for (let index = 0; index < dataBits; index++) {
      const shift = msb ? dataBits - index - 1 : index,
        level = (value >>> shift) & 1;
      yield* emit(packed(lines.map((line) => (line.name === active ? level : 1))), 1);
    }
    if (parity !== 'none') {
      let ones = 0;
      for (let index = 0; index < dataBits; index++) ones ^= (value >>> index) & 1;
      const level =
        parity === 'one' ? 1 : parity === 'zero' || parity === 'ignore' ? 0 : parity === 'odd' ? ones ^ 1 : ones;
      yield* emit(packed(lines.map((line) => (line.name === active ? level : 1))), 1);
    }
    yield* emit(idle, stopBits);
    yield* emit(idle, WITHIN_GAP);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit(idle, 2);
      }
      for (const item of data) {
        if (item.bytes.length !== 25) throw new RangeError('SBUS messages contain 25 bytes');
        for (const value of item.bytes) yield* byte(value, item.direction);
        yield* emit(idle, BETWEEN_GAP);
      }
    },
    *finish() {
      yield* emit(idle, 14);
      yield* writer.finish();
    },
  };
}
