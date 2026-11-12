import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'adf435x',
  name: 'ADF435x *',
  longname: 'Analog Devices ADF4350/1',
  desc: 'Wideband synthesizer with integrated VCO.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Clock/timing', 'IC', 'Wireless/RF'],
  annotations: [
    ['write', 'Register write'],
    ['warning', 'Warnings'],
  ],
  annotationRows: [
    ['writes', 'Register writes', [0]],
    ['warnings', 'Warnings', [1]],
  ],
};
