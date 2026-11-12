import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'swd',
  name: 'SWD *',
  longname: 'Serial Wire Debug',
  desc: 'Two-wire protocol for debug access to ARM CPUs.',
  inputs: ['logic'],
  outputs: ['swd'],
  tags: ['Debug/trace'],
  channels: [
    { id: 'swclk', name: 'SWCLK', desc: 'Master clock' },
    { id: 'swdio', name: 'SWDIO', desc: 'Data input/output' },
  ],
  options: [
    {
      id: 'strict_start',
      desc: 'Wait for a line reset before starting to decode',
      default: 'no',
      values: ['yes', 'no'],
    },
  ],
  annotations: [
    ['reset', 'RESET'],
    ['enable', 'ENABLE'],
    ['read', 'READ'],
    ['write', 'WRITE'],
    ['ack', 'ACK'],
    ['data', 'DATA'],
    ['parity', 'PARITY'],
  ],
};
