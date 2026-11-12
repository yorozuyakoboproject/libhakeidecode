import { PackedWaveformWriter } from '../../build/roundtrip.js';
import type { RoundtripCase, RoundtripConfig, WaveformEncoder } from '../../build/roundtrip.js';
import type { SignalWindow } from '../../libhakeidecode/types.js';
import type { UsbSpeed, UsbSignallingSymbol } from './index.js';
import { USB_LEAD_BITS, USB_PACKET_GAP_BITS, USB_TRAIL_BITS, stuffingBits, usbBitWidth } from './generator.js';
import type { UsbSignallingItem } from './generator.js';

function levels(speed: UsbSpeed, symbol: UsbSignallingSymbol): readonly [number, number] {
  if (symbol === 'SE0') return [0, 0];
  if (symbol === 'SE1') return [1, 1];
  if (speed === 'full-speed') return symbol === 'J' ? [1, 0] : [0, 1];
  return symbol === 'J' ? [0, 1] : [1, 0];
}

export interface UsbSignallingEncoderConfig extends RoundtripConfig {
  readonly busSpeed?: UsbSpeed;
}

export function createWaveformEncoder(config: UsbSignallingEncoderConfig): WaveformEncoder<UsbSignallingItem> {
  const writer = new PackedWaveformWriter(config);
  const dp = config.channels.dp!;
  const dm = config.channels.dm!;
  const speed: UsbSpeed = config.busSpeed ?? (config.options.signalling === 'low-speed' ? 'low-speed' : 'full-speed');
  const width = usbBitWidth(config.sampleRate, speed);
  let started = false;
  const packed = (symbol: UsbSignallingSymbol): number => {
    const [dpValue, dmValue] = levels(speed, symbol);
    return (dpValue << dp) | (dmValue << dm);
  };
  function* emit(symbol: UsbSignallingSymbol, samples: number): Iterable<SignalWindow> {
    if (samples > 0) yield* writer.write(packed(symbol), samples);
  }
  function* packet(bits: readonly number[]): Iterable<SignalWindow> {
    const wire = stuffingBits(bits);
    let symbol: UsbSignallingSymbol = 'J';
    for (const bit of wire) {
      if (bit === 0) symbol = symbol === 'J' ? 'K' : 'J';
      yield* emit(symbol, width);
    }
    yield* emit('SE0', 2 * width);
    yield* emit('J', USB_PACKET_GAP_BITS * width);
  }
  function* idle(kind: 'reset' | 'keep-alive', bits: number): Iterable<SignalWindow> {
    yield* emit('SE0', bits * width);
    yield* emit('J', USB_PACKET_GAP_BITS * width);
  }
  return {
    *push(data) {
      if (!started) {
        started = true;
        yield* emit('J', USB_LEAD_BITS * width);
      }
      for (const item of data) {
        if (item.kind === 'packet') yield* packet(item.bits);
        else yield* idle(item.kind, item.bits);
      }
    },
    *finish() {
      if (!started) {
        started = true;
        yield* emit('J', USB_LEAD_BITS * width);
      }
      yield* emit('J', USB_TRAIL_BITS * width);
      yield* writer.finish();
    },
  };
}

export function createEncoder(config: RoundtripCase<UsbSignallingItem>): WaveformEncoder<UsbSignallingItem> {
  return createWaveformEncoder(config);
}
