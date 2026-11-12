import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'cc1101',
  name: 'CC1101 *',
  longname: 'Texas Instruments CC1101',
  desc: 'Low-power sub-1GHz RF transceiver chip.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Wireless/RF'],
  annotations: [
    ['strobe', 'Command strobe'],
    ['single_read', 'Single register read'],
    ['single_write', 'Single register write'],
    ['burst_read', 'Burst register read'],
    ['burst_write', 'Burst register write'],
    ['status_read', 'Status read'],
    ['status_reg', 'Status register'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['cmds', 'Commands', [0]],
    ['data', 'Data', [1, 2, 3, 4, 5]],
    ['status', 'Status register', [6]],
    ['warnings', 'Warnings', [7]],
  ],
};
