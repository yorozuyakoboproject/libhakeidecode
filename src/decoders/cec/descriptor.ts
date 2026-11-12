import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'cec',
  name: 'CEC *',
  longname: 'HDMI-CEC',
  desc: 'HDMI Consumer Electronics Control (CEC) protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Display', 'PC'],
  channels: [{ id: 'cec', name: 'CEC', desc: 'CEC bus data' }],
  annotations: [
    ['st', 'Start'],
    ['eom-0', 'End of message'],
    ['eom-1', 'Message continued'],
    ['nack', 'ACK not set'],
    ['ack', 'ACK set'],
    ['bit', 'Bit'],
    ['byte', 'Byte'],
    ['frame', 'Frame'],
    ['section', 'Section'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2, 3, 4, 5]],
    ['bytes', 'Bytes', [6]],
    ['frames', 'Frames', [7]],
    ['sections', 'Sections', [8]],
    ['warnings', 'Warnings', [9]],
  ],
};
