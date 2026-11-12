import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ssi32',
  name: 'SSI32 *',
  longname: 'Synchronous Serial Interface (32bit)',
  desc: 'Synchronous Serial Interface (32bit) protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Embedded/industrial'],
  options: [{ id: 'msgsize', desc: 'Message size', default: 64 }],
  annotations: [
    ['ctrl-tx', 'CTRL TX'],
    ['ack-tx', 'ACK TX'],
    ['ctrl-rx', 'CTRL RX'],
    ['ack-rx', 'ACK RX'],
  ],
  annotationRows: [
    ['tx', 'TX', [0, 1]],
    ['rx', 'RX', [2, 3]],
  ],
};
