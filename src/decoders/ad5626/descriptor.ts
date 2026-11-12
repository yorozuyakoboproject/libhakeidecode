import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ad5626',
  name: 'AD5626 *',
  longname: 'Analog Devices AD5626',
  desc: 'Analog Devices AD5626 12-bit nanoDAC.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Analog/digital'],
  annotations: [['voltage', 'Voltage']],
};
