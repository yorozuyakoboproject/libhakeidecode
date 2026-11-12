import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'adxl345',
  name: 'ADXL345 *',
  longname: 'Analog Devices ADXL345',
  desc: 'Analog Devices ADXL345 3-axis accelerometer.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Sensor'],
  annotations: [
    ['read', 'Read'],
    ['write', 'Write'],
    ['mb', 'Multiple bytes'],
    ['reg-address', 'Register address'],
    ['reg-data', 'Register data'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['reg', 'Registers', [0, 1, 2, 3]],
    ['data', 'Data', [4, 5]],
  ],
};
