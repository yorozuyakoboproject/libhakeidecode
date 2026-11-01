import type { DecoderDescriptor } from '../../libhakeidecode/types.js';
import { TEXT_ORDERS, WIRE_ORDERS } from './orders.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ws2812',
  name: 'WS2812',
  longname: 'WS2812 addressable LED',
  desc: 'Pulse-width encoded RGB or RGBW pixel stream.',
  inputs: ['logic'],
  outputs: ['ws2812'],
  tags: ['Display'],
  channels: [{ id: 'din', name: 'DIN', desc: 'Serial data' }],
  options: [
    { id: 'wireorder', desc: 'Wire color order', default: 'GRB', values: WIRE_ORDERS },
    { id: 'textorder', desc: 'Display color order', default: 'RGB', values: TEXT_ORDERS },
  ],
  annotations: [
    ['pixel', 'Pixel'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['pixels', 'Pixels', [0]],
    ['warnings', 'Warnings', [1]],
  ],
};
