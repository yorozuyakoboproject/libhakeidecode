import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'pan1321',
  name: 'PAN1321 *',
  longname: 'Panasonic PAN1321',
  desc: 'Bluetooth RF module with Serial Port Profile (SPP).',
  inputs: ['uart'],
  outputs: [],
  tags: ['Wireless/RF'],
  annotations: [
    ['text-verbose', 'Text (verbose)'],
    ['text', 'Text'],
    ['warning', 'Warning'],
  ],
};
