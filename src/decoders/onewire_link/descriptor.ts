import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'onewire_link',
  name: '1-Wire link layer *',
  longname: '1-Wire serial communication bus (link layer)',
  desc: 'Bidirectional, half-duplex, asynchronous serial bus.',
  inputs: ['logic'],
  outputs: ['onewire_link'],
  tags: ['Embedded/industrial'],
  channels: [{ id: 'owr', name: 'OWR', desc: '1-Wire signal line' }],
  options: [{ id: 'overdrive', desc: 'Start in overdrive speed', default: 'no', values: ['yes', 'no'] }],
  annotations: [
    ['bit', 'Bit'],
    ['warning', 'Warning'],
    ['reset', 'Reset'],
    ['presence', 'Presence'],
    ['overdrive', 'Overdrive speed notification'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 2, 3]],
    ['info', 'Info', [4]],
    ['warnings', 'Warnings', [1]],
  ],
};
