import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { LinCase, LinMessage } from './generator.js';

export const LIN_BAUDRATE = 100_000;
export const LIN_SAMPLE_RATE = 400_000;
export const LIN_BIT_WIDTH = LIN_SAMPLE_RATE / LIN_BAUDRATE;
export const LIN_FRAME_BITS = 10;
export const LIN_BREAK_BITS = 13;
export const LIN_BREAK_GAP_BITS = 1;
export const LIN_TRAILING_IDLE_BITS = 45;
export const LIN_INITIAL_IDLE_BITS = 2;

export function linMessageByteCount(message: LinMessage): number {
  return 2 + message.data.length + (message.checksum === undefined ? 0 : 1);
}

export function linMessageWireBits(message: LinMessage): number {
  return LIN_BREAK_BITS + LIN_BREAK_GAP_BITS + linMessageByteCount(message) * LIN_FRAME_BITS + LIN_TRAILING_IDLE_BITS;
}

export function createEncoder(config: LinCase): WaveformEncoder<LinMessage> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.rx;
  if (channel === undefined) throw new RangeError('LIN encoder requires the UART rx channel.');
  const width = config.sampleRate / LIN_BAUDRATE;
  if (!Number.isInteger(width) || width < 1)
    throw new RangeError('LIN sample rate must be an integer multiple of the UART baud rate.');
  const high = 1 << channel;
  let started = false;

  function* write(value: number, bits: number): Iterable<SignalWindow> {
    if (bits > 0) yield* writer.write(value ? high : 0, bits * width);
  }

  function* byte(value: number, active: boolean): Iterable<SignalWindow> {
    yield* write(active ? 0 : 1, 1);
    for (let bit = 0; bit < 8; bit++) yield* write(active ? (value >>> bit) & 1 : 1, 1);
    yield* write(1, 1);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(1, LIN_INITIAL_IDLE_BITS);
      }
      for (const message of data) {
        yield* write(0, LIN_BREAK_BITS);
        yield* write(1, LIN_BREAK_GAP_BITS);
        yield* byte(message.sync, true);
        yield* byte(message.pid, true);
        for (const value of message.data) yield* byte(value, true);
        if (message.checksum !== undefined) yield* byte(message.checksum, true);
        yield* write(1, LIN_TRAILING_IDLE_BITS);
      }
    },
    *finish() {
      if (!started) yield* write(1, LIN_INITIAL_IDLE_BITS);
      yield* writer.finish();
    },
  };
}
