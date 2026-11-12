import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'eeprom93xx',
  name: '93xx EEPROM *',
  longname: '93xx Microwire EEPROM',
  desc: '93xx series Microwire EEPROM protocol.',
  inputs: ['microwire'],
  outputs: [],
  tags: ['IC', 'Memory'],
  options: [
    { id: 'addresssize', desc: 'Address size', default: 8 },
    { id: 'wordsize', desc: 'Word size', default: 16 },
    { id: 'format', desc: 'Data format', default: 'hex', values: ['ascii', 'hex'] },
  ],
  annotations: [
    ['si-data', 'SI data'],
    ['so-data', 'SO data'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['data', 'Data', [0, 1]],
    ['warnings', 'Warnings', [2]],
  ],
  binary: [
    ['address', 'Address'],
    ['data', 'Data'],
  ],
};
