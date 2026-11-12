import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'rc_encode',
  name: 'RC encode *',
  longname: 'Remote control encoder',
  desc: 'PT22x2/HX22x2/SC52x2 and xx1527 remote control encoder protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IC', 'IR'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  options: [
    { id: 'linecoding', desc: 'Encoding', default: 'SC52x2/HX22x2', values: ['SC52x2/HX22x2', 'xx1527'] },
    { id: 'remote', desc: 'Remote', default: 'none', values: ['none', 'maplin_l95ar'] },
  ],
  annotations: [
    ['bit-0', 'Bit 0'],
    ['bit-1', 'Bit 1'],
    ['bit-f', 'Bit f'],
    ['bit-U', 'Bit U'],
    ['bit-sync', 'Bit sync'],
    ['pin', 'Pin'],
    ['code-word-addr', 'Code word address'],
    ['code-word-data', 'Code word data'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2, 3, 4]],
    ['pins', 'Pins', [5]],
    ['code-words', 'Code words', [6, 7]],
  ],
};
