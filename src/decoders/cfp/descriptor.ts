import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'cfp',
  name: 'CFP *',
  longname: '100 Gigabit C form-factor pluggable',
  desc: '100 Gigabit C form-factor pluggable (CFP) protocol.',
  inputs: ['mdio'],
  outputs: [],
  tags: ['Networking'],
  annotations: [
    ['register', 'Register'],
    ['decode', 'Decode'],
  ],
  annotationRows: [
    ['registers', 'Registers', [0]],
    ['decodes', 'Decodes', [1]],
  ],
};
