import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'rf433',
  name: 'RF 433',
  longname: 'EV1527 and PT2262 radio remote control',
  desc: 'Pulse-coded 433 MHz remote-control frames.',
  inputs: ['logic'],
  outputs: ['rf433'],
  tags: ['Consumer'],
  channels: [{ id: 'data', name: 'DATA', desc: 'Demodulated radio data' }],
  options: [{ id: 'encoding', desc: 'Encoding', default: 'ev1527', values: ['ev1527', 'pt2262'] }],
  annotations: [
    ['frame', 'Frame'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['frames', 'Frames', [0]],
    ['warnings', 'Warnings', [1]],
  ],
};
