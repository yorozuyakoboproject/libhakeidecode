import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'st7735',
  name: 'ST7735 *',
  longname: 'Sitronix ST7735',
  desc: 'Sitronix ST7735 TFT controller protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Display', 'IC'],
  channels: [
    { id: 'cs', name: 'CS#', desc: 'Chip-select' },
    { id: 'clk', name: 'CLK', desc: 'Clock' },
    { id: 'mosi', name: 'MOSI', desc: 'Master out, slave in' },
    { id: 'dc', name: 'DC', desc: 'Data or command' },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['command', 'Command'],
    ['data', 'Data'],
    ['description', 'Description'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['fields', 'Fields', [1, 2]],
    ['descriptions', 'Descriptions', [3]],
  ],
};
