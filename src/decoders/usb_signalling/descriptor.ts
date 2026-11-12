import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'usb_signalling',
  name: 'USB signalling *',
  longname: 'Universal Serial Bus (LS/FS) signalling',
  desc: 'USB (low-speed/full-speed) signalling protocol.',
  inputs: ['logic'],
  outputs: ['usb_signalling'],
  tags: ['PC'],
  channels: [
    { id: 'dp', name: 'D+', desc: 'USB D+ signal' },
    { id: 'dm', name: 'D-', desc: 'USB D- signal' },
  ],
  options: [
    { id: 'signalling', desc: 'Signalling', default: 'automatic', values: ['automatic', 'full-speed', 'low-speed'] },
  ],
  annotations: [
    ['sym-j', 'J symbol'],
    ['sym-k', 'K symbol'],
    ['sym-se0', 'SE0 symbol'],
    ['sym-se1', 'SE1 symbol'],
    ['sop', 'Start of packet (SOP)'],
    ['eop', 'End of packet (EOP)'],
    ['bit', 'Bit'],
    ['stuffbit', 'Stuff bit'],
    ['error', 'Error'],
    ['keep-alive', 'Low-speed keep-alive'],
    ['reset', 'Reset'],
  ],
  annotationRows: [
    ['bits', 'Bits', [4, 5, 6, 7, 8, 9, 10]],
    ['symbols', 'Symbols', [0, 1, 2, 3]],
  ],
};
