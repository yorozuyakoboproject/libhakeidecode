import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ir_rc6',
  name: 'IR RC-6 *',
  longname: 'IR RC-6',
  desc: 'RC-6 infrared remote control protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IR'],
  channels: [{ id: 'ir', name: 'IR', desc: 'IR data line' }],
  options: [{ id: 'polarity', desc: 'Polarity', default: 'auto', values: ['auto', 'active-low', 'active-high'] }],
  annotations: [
    ['bit', 'Bit'],
    ['sync', 'Sync'],
    ['startbit', 'Startbit'],
    ['field', 'Field'],
    ['togglebit', 'Togglebit'],
    ['address', 'Address'],
    ['command', 'Command'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 2, 3, 4, 5, 6]],
  ],
};
