import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'lfast',
  name: 'LFAST *',
  longname: 'NXP LFAST interface',
  desc: 'Differential high-speed P2P interface',
  inputs: ['logic'],
  outputs: ['lfast'],
  tags: ['Embedded/industrial'],
  channels: [{ id: 'data', name: 'Data', desc: 'TXP or RXP' }],
  annotations: [
    ['bit', 'Bits'],
    ['sync', 'Sync Pattern'],
    ['header_pl_size', 'Payload Size'],
    ['header_ch_type', 'Logical Channel Type'],
    ['header_cts', 'Clear To Send'],
    ['payload', 'Payload'],
    ['ctrl_data', 'Control Data'],
    ['sleep', 'Sleep Bit'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 2, 3, 4, 5, 6, 7]],
    ['warnings', 'Warnings', [8]],
  ],
};
