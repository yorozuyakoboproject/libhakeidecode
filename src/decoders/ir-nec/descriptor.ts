import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ir-nec',
  name: 'IR NEC',
  longname: 'NEC infrared remote control',
  desc: 'Pulse-distance infrared remote-control protocol.',
  inputs: ['logic'],
  outputs: ['ir-nec'],
  tags: ['Consumer'],
  channels: [{ id: 'ir', name: 'IR', desc: 'Infrared input or demodulated receiver output' }],
  options: [
    {
      id: 'polarity',
      desc: 'Input polarity',
      default: 'active-low',
      values: ['auto', 'active-low', 'active-high'],
    },
    { id: 'carrier_frequency', desc: 'Carrier frequency', default: 0, min: 0, required: true },
    { id: 'extended', desc: 'Extended address', default: 'no', values: ['yes', 'no'] },
  ],
  annotations: [
    ['frame', 'Frame'],
    ['repeat', 'Repeat'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['frames', 'Frames', [0, 1]],
    ['warnings', 'Warnings', [2]],
  ],
};
