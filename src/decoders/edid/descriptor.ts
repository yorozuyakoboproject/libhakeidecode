import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'edid',
  name: 'EDID *',
  longname: 'Extended Display Identification Data',
  desc: 'Data structure describing display device capabilities.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Display', 'Memory', 'PC'],
  annotations: [
    ['field', 'Field'],
    ['section', 'Section'],
  ],
  annotationRows: [
    ['fields', 'Fields', [0]],
    ['sections', 'Sections', [1]],
  ],
};
