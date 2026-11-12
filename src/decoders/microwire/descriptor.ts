import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'microwire',
  name: 'Microwire *',
  longname: 'Microwire',
  desc: '3-wire, half-duplex, synchronous serial bus.',
  inputs: ['logic'],
  outputs: ['microwire'],
  tags: ['Embedded/industrial'],
  channels: [
    { id: 'cs', name: 'CS', desc: 'Chip select' },
    { id: 'sk', name: 'SK', desc: 'Clock' },
    { id: 'si', name: 'SI', desc: 'Slave in' },
    { id: 'so', name: 'SO', desc: 'Slave out' },
  ],
  annotations: [
    ['start-bit', 'Start bit'],
    ['si-bit', 'SI bit'],
    ['so-bit', 'SO bit'],
    ['status-check-ready', 'Status check ready'],
    ['status-check-busy', 'Status check busy'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['si-bits', 'SI bits', [0, 1]],
    ['so-bits', 'SO bits', [2]],
    ['status', 'Status', [3, 4]],
    ['warnings', 'Warnings', [5]],
  ],
};
