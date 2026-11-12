import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'guess_bitrate',
  name: 'Guess bitrate *',
  longname: 'Guess bitrate/baudrate',
  desc: 'Guess the bitrate/baudrate of a UART (or other) protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Clock/timing', 'Util'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  annotations: [['bitrate', 'Bitrate / baudrate']],
};
