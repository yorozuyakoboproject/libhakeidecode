import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'sbus_futaba',
  name: 'SBUS (Futaba) *',
  longname: 'Futaba SBUS (Serial bus)',
  desc: 'Serial bus for hobby remote control by Futaba',
  inputs: ['uart'],
  outputs: ['sbus_futaba'],
  tags: ['Remote Control'],
  options: [
    { id: 'prop_val_min', desc: 'Proportional value lower boundary', default: 0 },
    { id: 'prop_val_max', desc: 'Proportional value upper boundary', default: 2047 },
  ],
  annotations: [
    ['header', 'Header'],
    ['proportional', 'Proportional'],
    ['digital', 'Digital'],
    ['framelost', 'Frame Lost'],
    ['failsafe', 'Failsafe'],
    ['footer', 'Footer'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['framing', 'Framing', [0, 5, 3, 4]],
    ['channels', 'Channels', [1, 2]],
    ['warnings', 'Warnings', [6]],
  ],
};
