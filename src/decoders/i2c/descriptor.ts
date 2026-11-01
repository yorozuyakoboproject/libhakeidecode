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
    ['address', 'Address'],
    ['data', 'Data'],
    ['warning', 'Warning'],
    ['start', 'START'],
    ['stop', 'STOP'],
  ],
  annotationRows: [
    ['addresses', 'Addresses', [0]],
    ['data', 'Data', [1]],
    ['warnings', 'Warnings', [2]],
    ['conditions', 'Conditions', [3, 4]],
  ],
  binary: [
    ['address-read', 'Address reads'],
    ['address-write', 'Address writes'],
    ['data-read', 'Data reads'],
    ['data-write', 'Data writes'],
  ],
};
