import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'sae_j1850_vpw',
  name: 'SAE J1850 VPW *',
  longname: 'SAE J1850 VPW.',
  desc: 'SAE J1850 Variable Pulse Width 1x and 4x.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Automotive'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  annotations: [
    ['sof', 'SOF'],
    ['bit', 'Bit'],
    ['ifs', 'EOF/IFS'],
    ['byte', 'Byte'],
    ['prio', 'Priority'],
    ['dest', 'Destination'],
    ['src', 'Source'],
    ['mode', 'Mode'],
    ['data', 'Data'],
    ['csum', 'Checksum'],
    ['m1_pid', 'Pid'],
    ['warn', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2]],
    ['bytes', 'Bytes', [3]],
    ['fields', 'Fields', [4, 5, 6, 7, 8, 9]],
    ['values', 'Values', [10]],
    ['warns', 'Warnings', [11]],
  ],
};
