import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'qi',
  name: 'Qi *',
  longname: 'Qi charger protocol',
  desc: 'Protocol used by Qi receiver.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial', 'Wireless/RF'],
  channels: [{ id: 'qi', name: 'Qi', desc: 'Demodulated Qi data line' }],
  annotations: [
    ['bit', 'Bit'],
    ['byte-error', 'Bit error'],
    ['byte-start', 'Start bit'],
    ['byte-info', 'Info bit'],
    ['byte-data', 'Data byte'],
    ['packet-data', 'Packet data'],
    ['packet-checksum-ok', 'Packet checksum OK'],
    ['packet-checksum-err', 'Packet checksum error'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['bytes', 'Bytes', [1, 2, 3, 4]],
    ['packets', 'Packets', [5, 6, 7]],
  ],
};
