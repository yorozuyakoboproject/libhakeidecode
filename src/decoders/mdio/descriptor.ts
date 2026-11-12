import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'mdio',
  name: 'MDIO *',
  longname: 'Management Data Input/Output',
  desc: 'MII management bus between MAC and PHY.',
  inputs: ['logic'],
  outputs: ['mdio'],
  tags: ['Networking'],
  channels: [
    { id: 'mdc', name: 'MDC', desc: 'Clock' },
    { id: 'mdio', name: 'MDIO', desc: 'Data' },
  ],
  options: [{ id: 'show_debug_bits', desc: 'Show debug bits', default: 'no', values: ['yes', 'no'] }],
  annotations: [
    ['bit-val', 'Bit value'],
    ['bit-num', 'Bit number'],
    ['frame', 'Frame'],
    ['frame-idle', 'Bus idle state'],
    ['frame-error', 'Frame error'],
    ['decode', 'Decode'],
  ],
  annotationRows: [
    ['bit-vals', 'Bit values', [0]],
    ['bit-nums', 'Bit numbers', [1]],
    ['frames', 'Frames', [2, 3]],
    ['frame-errors', 'Frame errors', [4]],
    ['decode-vals', 'Decode', [5]],
  ],
};
