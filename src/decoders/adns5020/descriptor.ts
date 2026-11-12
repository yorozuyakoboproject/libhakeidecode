import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'adns5020',
  name: 'ADNS-5020 *',
  longname: 'Avago ADNS-5020',
  desc: 'Bidirectional optical mouse sensor protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'PC', 'Sensor'],
  annotations: [
    ['read', 'Register read'],
    ['write', 'Register write'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['reads', 'Reads', [0]],
    ['writes', 'Writes', [1]],
    ['warnings', 'Warnings', [2]],
  ],
};
