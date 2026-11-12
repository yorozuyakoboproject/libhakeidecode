import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'seven_segment',
  name: '7-segment *',
  longname: '7-segment display',
  desc: '7-segment display protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Display'],
  channels: [
    { id: 'a', name: 'A', desc: 'Segment A' },
    { id: 'b', name: 'B', desc: 'Segment B' },
    { id: 'c', name: 'C', desc: 'Segment C' },
    { id: 'd', name: 'D', desc: 'Segment D' },
    { id: 'e', name: 'E', desc: 'Segment E' },
    { id: 'f', name: 'F', desc: 'Segment F' },
    { id: 'g', name: 'G', desc: 'Segment G' },
  ],
  optionalChannels: [{ id: 'dp', name: 'DP', desc: 'Decimal point' }],
  options: [
    {
      id: 'polarity',
      desc: 'Expected polarity',
      default: 'common-cathode',
      values: ['common-cathode', 'common-anode'],
    },
    { id: 'show_unknown', desc: 'Display Unknown characters as #', default: 'no', values: ['yes', 'no'] },
  ],
  annotations: [['decoded-digit', 'Decoded digit']],
  annotationRows: [['decoded-digits', 'Decoded digits', [0]]],
};
