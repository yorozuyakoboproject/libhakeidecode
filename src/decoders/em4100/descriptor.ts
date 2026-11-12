import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'em4100',
  name: 'EM4100 *',
  longname: 'RFID EM4100',
  desc: 'EM4100 100-150kHz RFID protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IC', 'RFID'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  options: [
    { id: 'polarity', desc: 'Polarity', default: 'active-high', values: ['active-low', 'active-high'] },
    { id: 'datarate', desc: 'Data rate', default: 64, values: [64, 32, 16] },
    { id: 'coilfreq', desc: 'Coil frequency', default: 125000 },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['header', 'Header'],
    ['version-customer', 'Version/customer'],
    ['data', 'Data'],
    ['rowparity-ok', 'Row parity OK'],
    ['rowparity-err', 'Row parity error'],
    ['colparity-ok', 'Column parity OK'],
    ['colparity-err', 'Column parity error'],
    ['stopbit', 'Stop bit'],
    ['tag', 'Tag'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['tags', 'Tags', [9]],
  ],
};
