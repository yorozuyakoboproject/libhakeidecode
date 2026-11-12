import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'rfm12',
  name: 'RFM12 *',
  longname: 'HopeRF RFM12',
  desc: 'HopeRF RFM12 wireless transceiver control protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Wireless/RF'],
  annotations: [
    ['cmd', 'Command'],
    ['param', 'Command parameter'],
    ['disabled', 'Disabled bit'],
    ['return', 'Returned value'],
    ['disabled_return', 'Disabled returned value'],
    ['interpretation', 'Interpretation'],
  ],
  annotationRows: [
    ['commands', 'Commands', [0, 1, 2]],
    ['returns', 'Returns', [3, 4]],
    ['interpretations', 'Interpretations', [5]],
  ],
};
