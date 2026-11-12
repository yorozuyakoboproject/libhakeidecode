import type { WaveformEncoder } from '../../build/roundtrip.js';
import { createWaveformEncoder as createSignallingEncoder } from '../usb_signalling/encoder.js';
import type { UsbSignallingEncoderConfig } from '../usb_signalling/encoder.js';
import type { UsbSignalPacketItem } from '../usb_signalling/generator.js';
import { buildPacket } from './generator.js';
import type { UsbPacketCase, UsbPacketSpec } from './generator.js';

export function createEncoder(config: UsbPacketCase): WaveformEncoder<UsbPacketSpec> {
  const signallingConfig: UsbSignallingEncoderConfig = {
    ...config,
    options: { signalling: config.signalling },
    busSpeed: config.signalling,
  };
  const root = createSignallingEncoder(signallingConfig);
  return {
    *push(data) {
      const items: UsbSignalPacketItem[] = data.map((packet) => ({
        kind: 'packet',
        bits: buildPacket(packet).bits,
      }));
      yield* root.push(items);
    },
    *finish() {
      yield* root.finish();
    },
  };
}
