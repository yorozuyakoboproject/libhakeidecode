import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'midi',
  name: 'MIDI *',
  longname: 'Musical Instrument Digital Interface',
  desc: 'Musical Instrument Digital Interface (MIDI) protocol.',
  inputs: ['uart'],
  outputs: [],
  tags: ['Audio', 'PC'],
  annotations: [
    ['text-verbose', 'Text (verbose)'],
    ['text-sysreal-verbose', 'SysReal text (verbose)'],
    ['text-error', 'Error text'],
  ],
  annotationRows: [
    ['normal', 'Normal', [0, 2]],
    ['sys-real', 'SysReal', [1]],
  ],
};
