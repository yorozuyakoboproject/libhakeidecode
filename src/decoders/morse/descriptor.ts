import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'morse',
  name: 'Morse *',
  longname: 'Morse code',
  desc: 'Demodulated morse code protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Encoding'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  options: [{ id: 'timeunit', desc: 'Time unit (guess)', default: 0.1 }],
  annotations: [
    ['time', 'Time'],
    ['unit', 'Unit'],
    ['symbol', 'Symbol'],
    ['letter', 'Letter'],
    ['word', 'Word'],
  ],
  annotationRows: [
    ['times', 'Times', [0]],
    ['units', 'Units', [1]],
    ['symbols', 'Symbols', [2]],
    ['letters', 'Letters', [3]],
    ['words', 'Words', [4]],
  ],
};
