import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'wiegand',
  name: 'Wiegand *',
  longname: 'Wiegand interface',
  desc: 'Wiegand interface for electronic entry systems.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial', 'RFID'],
  channels: [
    { id: 'd0', name: 'D0', desc: 'Data 0 line' },
    { id: 'd1', name: 'D1', desc: 'Data 1 line' },
  ],
  options: [
    { id: 'active', desc: 'Data lines active level', default: 'low', values: ['low', 'high'] },
    { id: 'bitwidth_ms', desc: 'Single bit width in milliseconds', default: 4, values: [1, 2, 4, 8, 16, 32] },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['state', 'State'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['states', 'Stream states', [1]],
  ],
};
