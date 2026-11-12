import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'lin',
  name: 'LIN *',
  longname: 'Local Interconnect Network',
  desc: 'Local Interconnect Network (LIN) protocol.',
  inputs: ['uart'],
  outputs: [],
  tags: ['Automotive'],
  options: [{ id: 'version', desc: 'Protocol version', default: 2, values: [1, 2] }],
  annotations: [
    ['data', 'LIN data'],
    ['control', 'Protocol info'],
    ['error', 'Error description'],
    ['inline_error', 'Protocol violation or error'],
  ],
  annotationRows: [
    ['data_vals', 'Data', [0, 1, 3]],
    ['errors', 'Errors', [2]],
  ],
};
