import type { DeviceDescriptor } from '../../libhakei/device.js';
import { DEFAULT_DEMO_SIGNALS } from './signal.js';

export const DEMO_DEVICE_DESCRIPTOR = {
  id: 'demo',
  name: 'Demo device',
  capabilities: {
    sampleRate: { kind: 'range', min: 1, max: 1_000_000_000, step: 1, default: 1_000_000 },
    analogSampleRate: { kind: 'range', min: 1, max: 1_000_000_000, step: 1, default: 200_000 },
    sampleCount: { kind: 'range', min: 1n, max: (1n << 64n) - 1n, step: 1n, default: 200_000n },
    logicChannels: { kind: 'range', min: 0, max: 32, step: 1, default: 8 },
    analogChannels: { kind: 'range', min: 0, max: 4, step: 1, default: 2 },
  },
  analogInputs: [0, 1, 2, 3].map((index) => ({ index, name: `A${index}` })),
  options: [
    {
      id: 'signals',
      name: 'Signal generator',
      kind: 'text',
      default: DEFAULT_DEMO_SIGNALS,
      hidden: true,
    },
  ],
} as const satisfies DeviceDescriptor;
