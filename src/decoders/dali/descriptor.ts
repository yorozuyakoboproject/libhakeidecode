import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'dali',
  name: 'DALI *',
  longname: 'Digital Addressable Lighting Interface',
  desc: 'Digital Addressable Lighting Interface (DALI) protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial', 'Lighting'],
  channels: [{ id: 'dali', name: 'DALI', desc: 'DALI data line' }],
  options: [{ id: 'polarity', desc: 'Polarity', default: 'active-low', values: ['active-low', 'active-high'] }],
  annotations: [
    ['bit', 'Bit'],
    ['startbit', 'Start bit'],
    ['sbit', 'Select bit'],
    ['ybit', 'Individual or group'],
    ['address', 'Address'],
    ['command', 'Command'],
    ['reply', 'Reply data'],
    ['raw', 'Raw data'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['raw-data', 'Raw data', [7]],
    ['fields', 'Fields', [1, 2, 3, 4, 5, 6]],
  ],
};
