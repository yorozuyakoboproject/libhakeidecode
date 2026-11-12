import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'pjdl',
  name: 'PJDL *',
  longname: 'Padded Jittering Data Link',
  desc: 'PJDL, a single wire serial link layer for PJON.',
  inputs: ['logic'],
  outputs: ['pjon_link'],
  tags: ['Embedded/industrial'],
  channels: [{ id: 'data', name: 'DATA', desc: 'Single wire data' }],
  options: [
    { id: 'mode', desc: 'Communication mode', default: 1, values: [1, 2, 3, 4] },
    { id: 'idle_add_us', desc: 'Added idle time (us)', default: 4 },
  ],
  annotations: [
    ['cs_busy', 'Carrier busy'],
    ['cs_idle', 'Carrier idle'],
    ['bit_pad', 'Pad bit'],
    ['bit_low', 'Low bit'],
    ['bit_data', 'Data bit'],
    ['bit_short', 'Short data'],
    ['sync_loss', 'Sync loss'],
    ['byte', 'Data byte'],
    ['frame_init', 'Frame init'],
    ['frame_bytes', 'Frame bytes'],
    ['frame_wait', 'Frame wait'],
  ],
  annotationRows: [
    ['carriers', 'Carriers', [0, 1]],
    ['bits', 'Bits', [2, 3, 4, 5]],
    ['bytes', 'Bytes', [8, 7, 10]],
    ['frames', 'Frames', [9]],
    ['warns', 'Warnings', [6]],
  ],
};
