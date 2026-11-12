import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'sipi',
  name: 'SIPI (Zipwire) *',
  longname: 'NXP SIPI interface',
  desc: 'Serial Inter-Processor Interface (SIPI) aka Zipwire, aka HSSL',
  inputs: ['lfast'],
  outputs: [],
  tags: ['Embedded/industrial'],
  annotations: [
    ['header_tag', 'Transaction Tag'],
    ['header_cmd', 'Command Code'],
    ['header_ch', 'Channel'],
    ['address', 'Address'],
    ['data', 'Data'],
    ['crc', 'CRC'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['fields', 'Fields', [0, 1, 2, 3, 4, 5]],
    ['warnings', 'Warnings', [6]],
  ],
  binary: [['frames', 'LFAST payload bytes']],
};
