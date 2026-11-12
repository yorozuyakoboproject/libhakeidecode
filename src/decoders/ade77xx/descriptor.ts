import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ade77xx',
  name: 'ADE77xx *',
  longname: 'Analog Devices ADE77xx',
  desc: 'Poly phase multifunction energy metering IC protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Analog/digital', 'IC', 'Sensor'],
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
