import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { FlexRayCase, FlexRayFrame } from './generator.js';

const CRC_INIT_A = 0xfedcba;
const CRC_INIT_B = 0xabcdef;
const CRC_POLYNOMIAL = 0x5d6dcb;
const HEADER_CRC_INIT = 0x01a;
const HEADER_CRC_POLYNOMIAL = 0x385;
const CHANNEL_IDLE_DELIMITER = 11;

export const FLEXRAY_INITIAL_IDLE_BITS = 4;
export const FLEXRAY_INTERFRAME_IDLE_BITS = 8;
export const FLEXRAY_TSS_BITS = 30;

function crcBits(bits: readonly number[], polynomial: number, width: number, initial = 0): number {
  const mask = (1 << width) - 1;
  let register = initial & mask;
  for (const bit of bits) {
    const feedback = ((register >>> (width - 1)) & 1) ^ bit;
    register = (register << 1) & mask;
    if (feedback) register ^= polynomial;
  }
  return register & mask;
}

function appendField(bits: number[], value: number, width: number): void {
  for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
}

export function flexRayFrameBits(frame: FlexRayFrame, channel: 'A' | 'B'): number[] {
  if (!Number.isInteger(frame.id) || frame.id < 1 || frame.id > 2047)
    throw new RangeError('FlexRay frame IDs must be from 1 through 2047.');
  if (!Number.isInteger(frame.payloadLength) || frame.payloadLength < 0 || frame.payloadLength > 127)
    throw new RangeError('FlexRay payload lengths must be from 0 through 127.');
  if (!Number.isInteger(frame.cycle) || frame.cycle < 0 || frame.cycle > 63)
    throw new RangeError('FlexRay cycle codes must be from 0 through 63.');
  if (frame.data.length !== frame.payloadLength * 2)
    throw new RangeError('FlexRay payload must contain twice the header length field in bytes.');
  if (frame.data.some((value) => !Number.isInteger(value) || value < 0 || value > 0xff))
    throw new RangeError('FlexRay payload bytes must be integers from 0 through 255.');

  const header = [0, frame.payloadPreamble ? 1 : 0, frame.nullFrame ? 0 : 1, frame.sync ? 1 : 0, frame.startup ? 1 : 0];
  appendField(header, frame.id, 11);
  appendField(header, frame.payloadLength, 7);
  const headerCrc = crcBits(header.slice(3, 23), HEADER_CRC_POLYNOMIAL, 11, HEADER_CRC_INIT);
  appendField(header, headerCrc, 11);
  appendField(header, frame.cycle, 6);

  const body = [1, ...header];
  for (const value of frame.data) appendField(body, value, 8);
  const initial = channel === 'A' ? CRC_INIT_A : CRC_INIT_B;
  const frameCrc = crcBits(body.slice(1), CRC_POLYNOMIAL, 24, initial);
  appendField(body, frameCrc, 24);

  const wire = [body[0]!];
  for (let index = 1; index < body.length; index += 8) {
    wire.push(1, 0);
    for (let offset = 0; offset < 8; offset++) wire.push(body[index + offset]!);
  }
  wire.push(1, 0);
  for (let index = 0; index < CHANNEL_IDLE_DELIMITER; index++) wire.push(1);
  return wire;
}

export function createEncoder(config: FlexRayCase): WaveformEncoder<FlexRayFrame> {
  const writer = new PackedWaveformWriter(config);
  const channel = config.channels.channel;
  if (channel === undefined) throw new RangeError('FlexRay encoder requires the channel input.');
  const bitWidth = config.sampleRate / Number(config.options.bitrate);
  if (!Number.isInteger(bitWidth) || bitWidth < 1)
    throw new RangeError('FlexRay sample rate must be an integer multiple of the bitrate.');
  const channelType = String(config.options.channel_type) as 'A' | 'B';
  let started = false,
    frameWritten = false;

  function* write(value: number, bits: number): Iterable<SignalWindow> {
    if (bits > 0) yield* writer.write(value << channel, bits * bitWidth);
  }

  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* write(1, FLEXRAY_INITIAL_IDLE_BITS);
      }
      for (const frame of data) {
        if (frameWritten) yield* write(1, FLEXRAY_INTERFRAME_IDLE_BITS);
        yield* write(0, FLEXRAY_TSS_BITS);
        for (const bit of flexRayFrameBits(frame, channelType)) yield* write(bit, 1);
        frameWritten = true;
      }
    },
    *finish() {
      if (!started) yield* write(1, FLEXRAY_INITIAL_IDLE_BITS);
      yield* writer.finish();
    },
  };
}
