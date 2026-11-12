import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'max72xx',
  name: 'MAX72xx *',
  longname: 'Maxim MAX7219/MAX7221',
  desc: 'Maxim MAX72xx series 8-digit LED display driver',
  inputs: ['spi'],
  outputs: [],
  tags: ['Display'],
  options: [{ id: 'numofdrivers', desc: 'Number of daisy-chained chips', default: 1 }],
  annotations: [
    ['chip', 'Index of chip in daisy chain'],
    ['register', 'Registers written to the device'],
    ['digit', 'Digits displayed on the device'],
    ['warning', 'Human-readable warnings'],
  ],
  annotationRows: [
    ['chip_nr', 'Chip number', [0]],
    ['commands', 'Commands', [1, 2]],
    ['warnings', 'Warnings', [3]],
  ],
};
