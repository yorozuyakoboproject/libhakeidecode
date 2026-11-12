import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ds2408',
  name: 'DS2408 *',
  longname: 'Maxim DS2408',
  desc: '1-Wire 8-channel addressable switch.',
  inputs: ['onewire_network'],
  outputs: [],
  tags: ['Embedded/industrial', 'IC'],
  annotations: [['text', 'Text']],
};
