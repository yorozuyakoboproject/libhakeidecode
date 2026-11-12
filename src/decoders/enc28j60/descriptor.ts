import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'enc28j60',
  name: 'ENC28J60 *',
  longname: 'Microchip ENC28J60',
  desc: 'Microchip ENC28J60 10Base-T Ethernet controller protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Embedded/industrial', 'Networking'],
  annotations: [
    ['rcr', 'Read Control Register'],
    ['rbm', 'Read Buffer Memory'],
    ['wcr', 'Write Control Register'],
    ['wbm', 'Write Buffer Memory'],
    ['bfs', 'Bit Field Set'],
    ['bfc', 'Bit Field Clear'],
    ['src', 'System Reset Command'],
    ['data', 'Data'],
    ['reg-addr', 'Register Address'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['fields', 'Fields', [7, 8]],
    ['commands', 'Commands', [0, 1, 2, 3, 4, 5, 6]],
    ['warnings', 'Warnings', [9]],
  ],
};
