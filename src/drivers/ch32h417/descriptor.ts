import type { DeviceCapabilities, DeviceDescriptor } from '../../libhakei/device.js';
import type { Capabilities } from './protocol.js';

export const USB_VID = 0x0721,
  USB_PID = 0x2333;
export const SS_RATES = [
  6_250_000, 8_000_000, 10_000_000, 20_000_000, 25_000_000, 40_000_000, 50_000_000, 80_000_000, 100_000_000,
  200_000_000,
] as const;
export const defaultCaps: Capabilities = {
  analogMask: 0,
  adc1Mask: 0,
  hsadcMask: 0,
  adc1Budget: 562500,
  hsadcMax: 20000000,
  mixedBytesPerSecond: 180000000,
  packetBytes: 1024,
  blockBytes: 16384,
  heartbeatMs: 5000,
  channels: 8,
  rates: [...SS_RATES],
};
function capabilities(caps: Capabilities): DeviceCapabilities {
  return {
    sampleRate: { kind: 'list', values: caps.rates, default: caps.packetBytes === 1024 ? 40_000_000 : 10_000_000 },
    sampleCount: { kind: 'range', min: 1n, max: ((1n << 64n) - 1n) / 400000000n, step: 1n, default: 200_000n },
    logicChannels: { kind: 'list', values: [0, 1, 2, 3, 4, 5, 6, 7, 8], default: 8 },
    analogChannels: {
      kind: 'range',
      min: 0,
      max: caps.analogMask & 2 ? 2 : caps.analogMask & 1 ? 1 : 0,
      step: 1,
      default: 0,
    },
  };
}

export function descriptor(caps: Capabilities = defaultCaps): DeviceDescriptor {
  return {
    id: 'ch32h417',
    name: 'CH32H417 Logic Analyzer',
    capabilities: capabilities(caps),
    analogInputs: [0, 1]
      .filter((i) => caps.analogMask & (1 << i))
      .map((index) => ({ index, name: `PC${index + 1} · ${caps.hsadcMask & (1 << index) ? 'HSADC' : 'ADC1'}` })),
    options: [
      {
        id: 'hsadcHz',
        name: 'HSADC sampling rate (Hz)',
        kind: 'number',
        min: 1250000,
        max: caps.hsadcMax,
        step: 1,
        default: caps.packetBytes === 512 ? 1250000 : 10000000,
      },
      {
        id: 'adc1Hz',
        name: 'ADC1 rate per channel (Hz)',
        kind: 'number',
        min: 1,
        max: caps.adc1Budget,
        step: 1,
        default: 100000,
      },
      {
        id: 'durationMs',
        name: 'Analog/mixed capture duration (ms)',
        kind: 'number',
        min: 1,
        max: 60000,
        step: 0.001,
        default: 200,
      },
    ],
  };
}
