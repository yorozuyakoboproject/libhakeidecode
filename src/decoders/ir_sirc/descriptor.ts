import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ir_sirc',
  name: 'IR SIRC *',
  longname: 'Sony IR (SIRC)',
  desc: 'Sony infrared remote control protocol (SIRC).',
  inputs: ['logic'],
  outputs: [],
  tags: ['IR'],
  channels: [{ id: 'ir', name: 'IR', desc: 'IR data line' }],
  options: [{ id: 'polarity', desc: 'Polarity', default: 'active-low', values: ['active-low', 'active-high'] }],
  annotations: [
    ['bit', 'Bit'],
    ['agc', 'AGC'],
    ['pause', 'Pause'],
    ['start', 'Start'],
    ['command', 'Command'],
    ['address', 'Address'],
    ['extended', 'Extended'],
    ['remote', 'Remote'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2]],
    ['fields', 'Fields', [3, 4, 5, 6]],
    ['remotes', 'Remotes', [7]],
    ['warnings', 'Warnings', [8]],
  ],
};
