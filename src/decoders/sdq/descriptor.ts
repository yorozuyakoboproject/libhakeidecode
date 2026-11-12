import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'sdq',
  name: 'SDQ *',
  longname: 'Texas Instruments SDQ',
  desc: 'Texas Instruments SDQ. The SDQ protocol is also used by Apple.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial'],
  channels: [{ id: 'sdq', name: 'SDQ', desc: 'Single wire SDQ data line.' }],
  options: [{ id: 'bitrate', desc: 'Bit rate', default: 98425 }],
  annotations: [
    ['bit', 'Bit'],
    ['byte', 'Byte'],
    ['break', 'Break'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['bytes', 'Bytes', [1]],
    ['breaks', 'Breaks', [2]],
  ],
};
