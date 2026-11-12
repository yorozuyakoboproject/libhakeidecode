import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'i2cfilter',
  name: 'I²C filter *',
  longname: 'I²C filter',
  desc: 'Filter out addresses/directions in an I²C stream.',
  inputs: ['i2c'],
  outputs: ['i2c'],
  tags: ['Util'],
  options: [
    { id: 'address', desc: 'Slave address to filter (decimal)', default: 0 },
    { id: 'direction', desc: 'Direction to filter', default: 'both', values: ['read', 'write', 'both'] },
  ],
};
