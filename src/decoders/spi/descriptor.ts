import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'spi',
  name: 'SPI',
  longname: 'Serial Peripheral Interface',
  desc: 'Synchronous serial bus with clock, data and optional chip select.',
  inputs: ['logic'],
  outputs: ['spi'],
  tags: ['Embedded/industrial'],
  channels: [{ id: 'clk', name: 'CLK', desc: 'Serial clock' }],
  optionalChannels: [
    { id: 'miso', name: 'MISO', desc: 'Master input, slave output', optional: true },
    { id: 'mosi', name: 'MOSI', desc: 'Master output, slave input', optional: true },
    { id: 'cs', name: 'CS', desc: 'Chip select', optional: true },
  ],
  options: [
    { id: 'cs_polarity', desc: 'CS polarity', default: 'active-low', values: ['active-low', 'active-high'] },
    { id: 'cpol', desc: 'Clock polarity', default: 0, values: [0, 1] },
    { id: 'cpha', desc: 'Clock phase', default: 0, values: [0, 1] },
    { id: 'bitorder', desc: 'Bit order', default: 'msb-first', values: ['msb-first', 'lsb-first'] },
    { id: 'wordsize', desc: 'Word size', default: 8, min: 1, max: 32, required: true },
  ],
  annotations: [
    ['word', 'Word'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['words', 'Words', [0]],
    ['warnings', 'Warnings', [1]],
  ],
  binary: [
    ['mosi', 'MOSI words'],
    ['miso', 'MISO words'],
  ],
};
