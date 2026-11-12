import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ook',
  name: 'OOK *',
  longname: 'On-off keying',
  desc: 'On-off keying protocol.',
  inputs: ['logic'],
  outputs: ['ook'],
  tags: ['Encoding'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  options: [
    { id: 'invert', desc: 'Invert data', default: 'no', values: ['no', 'yes'] },
    { id: 'decodeas', desc: 'Decode type', default: 'Manchester', values: ['NRZ', 'Manchester', 'Diff Manchester'] },
    { id: 'preamble', desc: 'Preamble', default: 'auto', values: ['auto', '1010', '1111'] },
    { id: 'preamlen', desc: 'Filter length', default: '7', values: ['0', '3', '4', '5', '6', '7', '8', '9', '10'] },
    { id: 'diffmanvar', desc: 'Transition at start', default: '1', values: ['1', '0'] },
  ],
  annotations: [
    ['frame', 'Frame'],
    ['info', 'Info'],
    ['1111', '1111'],
    ['1010', '1010'],
    ['diffman', 'Diff man'],
    ['nrz', 'NRZ'],
  ],
  annotationRows: [
    ['frames', 'Framing', [0]],
    ['info-vals', 'Info', [1]],
    ['man1111', 'Man 1111', [2]],
    ['man1010', 'Man 1010', [3]],
    ['diffmans', 'Diff man', [4]],
    ['nrz-vals', 'NRZ', [5]],
  ],
  binary: [['pulse-lengths', 'Pulse lengths']],
};
