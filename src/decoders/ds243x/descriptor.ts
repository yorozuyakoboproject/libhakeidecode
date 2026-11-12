import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ds243x',
  name: 'DS243x *',
  longname: 'Maxim DS2432/3',
  desc: 'Maxim DS243x series 1-Wire EEPROM protocol.',
  inputs: ['onewire_network'],
  outputs: [],
  tags: ['IC', 'Memory'],
  annotations: [['text', 'Text']],
  binary: [['mem_read', 'Data read from memory']],
};
