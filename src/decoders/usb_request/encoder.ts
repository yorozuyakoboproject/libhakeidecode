import type { WaveformEncoder } from '../../build/roundtrip.js';
import { createEncoder as createPacketEncoder } from '../usb_packet/encoder.js';
import type { UsbPacketCase, UsbPacketSpec } from '../usb_packet/generator.js';
import type { UsbRequestCase } from './generator.js';

export function createEncoder(config: UsbRequestCase): WaveformEncoder<UsbPacketSpec> {
  const packetConfig: UsbPacketCase = {
    ...config,
    options: { signalling: config.signalling },
    signalling: config.signalling,
  };
  return createPacketEncoder(packetConfig);
}
