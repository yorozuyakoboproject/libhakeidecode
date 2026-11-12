import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'dsi',
  name: 'DSI *',
  longname: 'Digital Serial Interface',
  desc: 'Digital Serial Interface (DSI) lighting protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial', 'Lighting'],
  channels: [{ id: 'dsi', name: 'DSI', desc: 'DSI data line' }],
  options: [{ id: 'polarity', desc: 'Polarity', default: 'active-high', values: ['active-low', 'active-high'] }],
  annotations: [
    ['bit', 'Bit'],
    ['startbit', 'Start bit'],
    ['level', 'Dimmer level'],
    ['raw', 'Raw data'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0]],
    ['raw-vals', 'Raw data', [3]],
    ['fields', 'Fields', [1, 2]],
  ],
};
