import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ds28ea00',
  name: 'DS28EA00 *',
  longname: 'Maxim DS28EA00 1-Wire digital thermometer',
  desc: '1-Wire digital thermometer with Sequence Detect and PIO.',
  inputs: ['onewire_network'],
  outputs: [],
  tags: ['IC', 'Sensor'],
  annotations: [['text', 'Text']],
};
