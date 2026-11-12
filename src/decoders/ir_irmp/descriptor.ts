import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ir_irmp',
  name: 'IR IRMP *',
  longname: 'IR IRMP',
  desc: 'IRMP infrared remote control multi protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IR'],
  channels: [{ id: 'ir', name: 'IR', desc: 'Data line' }],
  options: [
    {
      id: 'polarity',
      desc: 'Polarity',
      default: 'active-low',
      values: ['active-low', 'active-high'],
    },
  ],
  annotations: [['packet', 'Packet']],
  annotationRows: [['packets', 'IR Packets', [0]]],
};
