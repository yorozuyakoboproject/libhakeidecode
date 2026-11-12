import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'mxc6225xu',
  name: 'MXC6225XU *',
  longname: 'MEMSIC MXC6225XU',
  desc: 'Digital Thermal Orientation Sensor (DTOS) protocol.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['IC', 'Sensor'],
  annotations: [['text', 'Text']],
};
