import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'i2c',
  name: 'I2C',
  longname: 'Inter-Integrated Circuit',
  desc: 'Two-wire synchronous serial bus.',
  inputs: ['logic'],
  outputs: ['i2c'],
  tags: ['Embedded/industrial'],
  channels: [
    { id: 'scl', name: 'SCL', desc: 'Serial clock' },
    { id: 'sda', name: 'SDA', desc: 'Serial data' },
  ],
  options: [
    {
      id: 'address_format',
      desc: 'Address format',
      default: 'shifted',
      values: ['shifted', 'unshifted'],
    },
  ],
  annotations: [
    ['start', 'Start condition'],
    ['repeat-start', 'Repeat start condition'],
    ['stop', 'Stop condition'],
    ['ack', 'ACK'],
    ['nack', 'NACK'],
    ['bit', 'Data/address bit'],
    ['address-read', 'Address read'],
    ['address-write', 'Address write'],
    ['data-read', 'Data read'],
    ['data-write', 'Data write'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [5]],
    ['addr-data', 'Address/data', [0, 1, 2, 3, 4, 6, 7, 8, 9]],
    ['warnings', 'Warnings', [10]],
  ],
  binary: [
    ['address-read', 'Address reads'],
    ['address-write', 'Address writes'],
    ['data-read', 'Data reads'],
    ['data-write', 'Data writes'],
  ],
};
