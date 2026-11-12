import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'onewire_network',
  name: '1-Wire network layer *',
  longname: '1-Wire serial communication bus (network layer)',
  desc: 'Bidirectional, half-duplex, asynchronous serial bus.',
  inputs: ['onewire_link'],
  outputs: ['onewire_network'],
  tags: ['Embedded/industrial'],
  annotations: [['text', 'Text']],
};
