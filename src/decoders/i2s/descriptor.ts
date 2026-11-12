import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'i2s',
  name: 'I²S *',
  longname: 'Integrated Interchip Sound',
  desc: 'Serial bus for connecting digital audio devices.',
  inputs: ['logic'],
  outputs: ['i2s'],
  tags: ['Audio', 'PC'],
  channels: [
    { id: 'sck', name: 'SCK', desc: 'Bit clock line' },
    { id: 'ws', name: 'WS', desc: 'Word select line' },
    { id: 'sd', name: 'SD', desc: 'Serial data line' },
  ],
  annotations: [
    ['left', 'Left channel'],
    ['right', 'Right channel'],
    ['warnings', 'Warnings'],
  ],
  binary: [['wav', 'WAV file']],
};
