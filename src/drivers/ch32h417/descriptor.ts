import type { DeviceCapabilities, DeviceDescriptor } from '../../libhakei/device.js';
import type { Capabilities } from './protocol.js';

export const USB_VID = 0x0721,
  USB_PID = 0x2333;
export const SS_RATES = [
  6_250_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 40_000_000, 50_000_000, 80_000_000, 100_000_000,
  200_000_000,
] as const;
export const defaultCaps: Capabilities = {
  packetBytes: 1024,
  blockBytes: 16384,
  heartbeatMs: 5000,
  channels: 8,
  rates: [...SS_RATES],
};
function capabilities(caps: Capabilities): DeviceCapabilities {
  return {
    sampleRate: { kind: 'list', values: caps.rates, default: caps.packetBytes === 1024 ? 40_000_000 : 10_000_000 },
    sampleCount: { kind: 'range', min: 1n, max: (1n << 64n) - 1n, step: 1n, default: 200_000n },
    logicChannels: { kind: 'list', values: [1, 2, 3, 4, 5, 6, 7, 8], default: 8 },
    analogChannels: { kind: 'list', values: [0], default: 0 },
  };
}

export function descriptor(caps: Capabilities = defaultCaps): DeviceDescriptor {
  return { id: 'ch32h417', name: 'CH32H417 Logic Analyzer', capabilities: capabilities(caps), options: [] };
}
