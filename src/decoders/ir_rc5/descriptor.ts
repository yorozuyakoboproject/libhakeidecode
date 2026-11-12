import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ir_rc5',
  name: 'IR RC-5 *',
  longname: 'IR RC-5',
  desc: 'RC-5 infrared remote control protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IR'],
  channels: [{ id: 'ir', name: 'IR', desc: 'IR data line' }],
  options: [
    { id: 'polarity', desc: 'Polarity', default: 'active-low', values: ['active-low', 'active-high'] },
    { id: 'protocol', desc: 'Protocol type', default: 'standard', values: ['standard', 'extended'] },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['startbit1', 'Startbit 1'],
    ['startbit2', 'Startbit 2'],
    ['togglebit-0', 'Toggle bit 0'],
    ['togglebit-1', 'Toggle bit 1'],
    ['address', 'Address'],
    ['command', 'Command'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 2, 3, 4, 5, 6]],
  ],
};
