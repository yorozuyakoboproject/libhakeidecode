import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import {
  frameBits,
  getProtocolSpec,
  IRMP_BASE_RATE,
  IRMP_FRAME_GAP_TICKS,
  IRMP_NEC_REPEAT_GAP_TICKS,
  IRMP_NEC_REPEAT_HEADER_TICKS,
  IRMP_NEC_REPEAT_STOP_TICKS,
} from './index.js';
import type { IrmpFrame } from './index.js';
import type { IrIrmpCase } from './generator.js';

const necRepeatProtocols = new Set([2, 11, 20, 56]);
const NETBOX_SLOT_TICKS = 16;

export function createEncoder(config: IrIrmpCase): WaveformEncoder<IrmpFrame> {
  if (config.sampleRate % IRMP_BASE_RATE) {
    throw new RangeError(`Sample rate must be a multiple of ${IRMP_BASE_RATE}`);
  }
  const channel = config.channels.ir;
  if (channel === undefined) throw new RangeError('Missing IR channel');
  const factor = config.sampleRate / IRMP_BASE_RATE;
  const activeHigh = config.options.polarity === 'active-high';
  const inactiveLevel = activeHigh ? 0 : 1;
  const writer = new PackedWaveformWriter(config);
  let level = inactiveLevel;
  let run = 0;

  function* flush(): Iterable<SignalWindow> {
    if (!run) return;
    yield* writer.write(level << channel, run);
    run = 0;
  }

  function* writeLevel(active: boolean, ticks: number): Iterable<SignalWindow> {
    if (ticks <= 0) return;
    const raw = active === activeHigh ? 1 : 0;
    if (raw !== level) {
      yield* flush();
      level = raw;
    }
    run += ticks * factor;
  }

  function* writeSync(pulse: number, gap: number): Iterable<SignalWindow> {
    yield* writeLevel(true, pulse);
    yield* writeLevel(false, gap);
  }

  function* writeBits(frame: IrmpFrame): Iterable<SignalWindow> {
    const spec = getProtocolSpec(frame.protocol);
    const bits = frame.raw ? [...frame.raw] : frameBits(spec, frame);

    if (spec.family === 'pulse-distance') {
      if (spec.id === 26) {
        for (const bit of bits) yield* writeLevel(bit === 1, NETBOX_SLOT_TICKS);
        if (spec.stopPulse) yield* writeLevel(true, spec.stopPulse);
        return;
      }
      for (const [index, bit] of bits.entries()) {
        if (spec.syncAfterBit > 0 && index === spec.syncAfterBit) {
          yield* writeSync(spec.pulseZero, spec.headerGap);
          continue;
        }
        yield* writeLevel(true, bit ? spec.pulseOne : spec.pulseZero);
        yield* writeLevel(false, bit ? spec.gapOne : spec.gapZero);
      }
      if (spec.stopBit) yield* writeLevel(true, spec.stopPulse || spec.pulseZero);
      return;
    }

    if (spec.family === 'manchester') {
      for (const bit of bits) {
        yield* writeLevel(bit === 1, spec.half);
        yield* writeLevel(bit === 0, spec.half);
      }
      if (spec.stopBit) yield* writeLevel(true, spec.half);
      return;
    }

    for (let index = 0; index < bits.length; index += 2) {
      const code = (bits[index]! << 1) | bits[index + 1]!;
      yield* writeLevel(true, spec.rcmmPulse);
      yield* writeLevel(false, spec.rcmmGaps[code]!);
    }
    if (spec.stopBit) yield* writeLevel(true, spec.rcmmPulse);
  }

  function* frameWaveform(frame: IrmpFrame): Iterable<SignalWindow> {
    const gap = frame.gapTicks ?? IRMP_FRAME_GAP_TICKS + 2;
    if (!Number.isSafeInteger(gap) || gap < 1) throw new RangeError(`Invalid IR frame gap: ${gap}`);
    yield* writeLevel(false, gap);
    if (frame.repeat) {
      if (!necRepeatProtocols.has(frame.protocol)) throw new Error(`Protocol ${frame.protocol} has no repeat waveform`);
      yield* writeLevel(true, IRMP_NEC_REPEAT_HEADER_TICKS);
      yield* writeLevel(false, IRMP_NEC_REPEAT_GAP_TICKS);
      yield* writeLevel(true, IRMP_NEC_REPEAT_STOP_TICKS);
      return;
    }
    const spec = getProtocolSpec(frame.protocol);
    const multiplier = frame.startMultiplier ?? 1;
    yield* writeLevel(true, spec.headerPulse * multiplier);
    yield* writeLevel(false, spec.headerGap * multiplier);
    yield* writeBits(frame);
  }

  return {
    *push(data) {
      for (const frame of data) yield* frameWaveform(frame);
    },
    *finish() {
      yield* writeLevel(false, IRMP_FRAME_GAP_TICKS + 2);
      yield* flush();
      yield* writer.finish();
    },
  };
}
