import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'miller',
  name: 'Miller *',
  longname: 'Miller encoding',
  desc: 'Miller encoding protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Encoding'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data signal' }],
  options: [
    { id: 'baudrate', desc: 'Baud rate', default: 106000 },
    { id: 'edge', desc: 'Edge', default: 'falling', values: ['rising', 'falling', 'either'] },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['bitstring', 'Bitstring'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['bitstrings', 'Bitstrings', [1]],
  ],
  binary: [['raw', 'Raw binary']],
};
