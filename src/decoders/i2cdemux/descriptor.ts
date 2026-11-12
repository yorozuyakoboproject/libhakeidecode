import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'i2cdemux',
  name: 'I²C demux *',
  longname: 'I²C demultiplexer',
  desc: 'Demux I²C packets into per-slave-address streams.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Util'],
};
