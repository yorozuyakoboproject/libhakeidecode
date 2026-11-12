import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ps2',
  name: 'PS/2 *',
  longname: 'PS/2',
  desc: 'PS/2 keyboard/mouse interface.',
  inputs: ['logic'],
  outputs: [],
  tags: ['PC'],
  channels: [
    { id: 'clk', name: 'Clock', desc: 'Clock line' },
    { id: 'data', name: 'Data', desc: 'Data line' },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['start-bit', 'Start bit'],
    ['stop-bit', 'Stop bit'],
    ['parity-ok', 'Parity OK bit'],
    ['parity-err', 'Parity error bit'],
    ['data-bit', 'Data bit'],
    ['word', 'Word'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 2, 3, 4, 5, 6]],
  ],
};
