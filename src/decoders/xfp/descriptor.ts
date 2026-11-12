import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'xfp',
  name: 'XFP *',
  longname: '10 Gigabit Small Form Factor Pluggable Module (XFP)',
  desc: 'XFP I²C management interface structures/protocol',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Networking'],
  annotations: [
    ['field-name-and-val', 'Field name and value'],
    ['field-val', 'Field value'],
  ],
  annotationRows: [
    ['field-names-and-vals', 'Field names and values', [0]],
    ['field-vals', 'Field values', [1]],
  ],
};
