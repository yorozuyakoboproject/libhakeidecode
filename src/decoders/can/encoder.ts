import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { CanCase, CanFrame } from './generator.js';

export interface CanWireBit {
  readonly value: number;
  readonly stuff: boolean;
}

export const CAN_INITIAL_IDLE_SAMPLES = 8;
export const CAN_SAMPLE_POINT_PERCENT = 70;

function dlcToLength(dlc: number): number {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64][dlc] ?? 0;
}

function appendField(bits: number[], value: number, width: number): void {
  for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
}

function addStuffing(actual: readonly number[], end: number): CanWireBit[] {
  const wire: CanWireBit[] = [];
  let runValue = -1;
  let runLength = 0;
  for (let index = 0; index < actual.length; index++) {
    if (index < end && runLength === 5) {
      const value = runValue ^ 1;
      wire.push({ value, stuff: true });
      runValue = value;
      runLength = 1;
    }
    const value = actual[index]!;
    wire.push({ value, stuff: false });
    if (value === runValue) runLength++;
    else {
      runValue = value;
      runLength = 1;
    }
  }
  return wire;
}

export function canFrameBits(frame: CanFrame): CanWireBit[] {
  const dataLength = dlcToLength(frame.dlc);
  const data = frame.data ?? [];
  if (!Number.isInteger(frame.dlc) || frame.dlc < 0 || frame.dlc > 15)
    throw new RangeError('CAN DLC must be an integer from 0 through 15.');
  if (!Number.isInteger(frame.id) || frame.id < 0)
    throw new RangeError('CAN identifier must be a non-negative integer.');
  if (!frame.extended && frame.id > 0x7ff) throw new RangeError('Standard CAN identifiers are 11 bits.');
  if (frame.extended && frame.id > 0x1fffffff) throw new RangeError('Extended CAN identifiers are 29 bits.');
  if (frame.rtr && data.length) throw new RangeError('CAN remote frames cannot contain payload data.');
  if (!frame.rtr && data.length !== dataLength) throw new RangeError('CAN data length does not match DLC.');
  if (data.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff))
    throw new RangeError('CAN data bytes must be integers from 0 through 255.');

  const actual: number[] = [0];
  if (frame.extended) {
    appendField(actual, frame.id >>> 18, 11);
    actual.push(1, 1);
    appendField(actual, frame.id & 0x3ffff, 18);
    actual.push(frame.rtr ? 1 : 0, 0, 0);
  } else {
    appendField(actual, frame.id, 11);
    actual.push(frame.rtr ? 1 : 0, 0, 0);
  }
  appendField(actual, frame.dlc, 4);
  for (const value of data) appendField(actual, value, 8);
  appendField(actual, 0x1234 & 0x7fff, 15);
  const wire = addStuffing(actual, actual.length);
  wire.push(
    { value: 1, stuff: false },
    { value: 0, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
    { value: 1, stuff: false },
  );
  return wire;
}

export function createEncoder(config: CanCase): WaveformEncoder<CanFrame> {
  const writer = new PackedWaveformWriter(config);
  const bit = config.channels.can_rx;
  if (bit === undefined) throw new RangeError('CAN encoder requires the can_rx channel.');
  const bitWidth = config.sampleRate / Number(config.options.nominal_bitrate);
  if (!Number.isInteger(bitWidth) || bitWidth < 1)
    throw new RangeError('CAN sample rate must be an integer multiple of the nominal bitrate.');
  const idleSamples = Math.max(4, Math.ceil(bitWidth * 2.5));
  let started = false;

  function* write(value: number, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(value << bit, samples);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(1, CAN_INITIAL_IDLE_SAMPLES);
      }
      for (const frame of data) {
        for (const wireBit of canFrameBits(frame)) yield* write(wireBit.value, bitWidth);
        yield* write(1, idleSamples);
      }
    },
    *finish() {
      if (!started) yield* write(1, CAN_INITIAL_IDLE_SAMPLES);
      yield* writer.finish();
    },
  };
}
