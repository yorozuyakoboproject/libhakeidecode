import type { DeviceDescriptor } from '../../libhakei/device.js';

export const DEMO_DEVICE_DESCRIPTOR = {
  id: 'demo',
  name: 'Demo device',
  capabilities: {
    sampleRate: { kind: 'range', min: 1, max: 1_000_000_000, step: 1, default: 200_000 },
    sampleCount: { kind: 'range', min: 1n, max: (1n << 64n) - 1n, step: 1n, default: 200_000n },
    logicChannels: { kind: 'range', min: 0, max: 32, step: 1, default: 8 },
    analogChannels: { kind: 'range', min: 0, max: 4, step: 1, default: 2 },
  },
  options: [
    {
      id: 'logicPattern',
      name: 'Logic pattern',
      kind: 'choice',
      values: ['square', 'clock', 'random', 'incremental', 'walking-one', 'walking-zero'],
      default: 'square',
    },
    {
      id: 'analogPattern',
      name: 'Analog pattern',
      kind: 'choice',
      values: ['sine', 'square', 'triangle', 'sawtooth', 'random', 'constant'],
      default: 'sine',
    },
    { id: 'frequencyHz', name: 'Signal frequency (Hz)', kind: 'number', min: 1, max: 1_000_000_000, default: 1_000 },
    { id: 'amplitude', name: 'Amplitude', kind: 'number', min: 0, default: 1 },
    { id: 'offset', name: 'Offset', kind: 'number', default: 0 },
    { id: 'seed', name: 'Seed', kind: 'number', min: 0, max: 0xffffffff, step: 1, default: 1 },
  ],
} as const satisfies DeviceDescriptor;
