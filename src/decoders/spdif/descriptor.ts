import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'spdif',
  name: 'S/PDIF *',
  longname: 'Sony/Philips Digital Interface Format',
  desc: 'Serial bus for connecting digital audio devices.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Audio', 'PC'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  annotations: [
    ['bitrate', 'Bitrate / baudrate'],
    ['preamble', 'Preamble'],
    ['bit', 'Bit'],
    ['aux', 'Auxillary-audio-databit'],
    ['sample', 'Audio Sample'],
    ['validity', 'Data Valid'],
    ['subcode', 'Subcode data'],
    ['chan_stat', 'Channnel Status'],
    ['parity', 'Parity Bit'],
  ],
  annotationRows: [
    ['bits', 'Bits', [2]],
    ['info', 'Info', [0, 1, 3, 5, 6, 7, 8]],
    ['samples', 'Samples', [4]],
  ],
};
