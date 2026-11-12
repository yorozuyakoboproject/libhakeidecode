import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'caliper',
  name: 'Caliper *',
  longname: 'Digital calipers',
  desc: 'Protocol of cheap generic digital calipers.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Analog/digital', 'Sensor'],
  channels: [
    { id: 'clk', name: 'CLK', desc: 'Serial clock line' },
    { id: 'data', name: 'DATA', desc: 'Serial data line' },
  ],
  options: [
    { id: 'timeout_ms', desc: 'Packet timeout in ms, 0 to disable', default: 10 },
    { id: 'unit', desc: 'Convert units', default: 'keep', values: ['keep', 'mm', 'inch'] },
    { id: 'changes', desc: 'Changes only', default: 'no', values: ['no', 'yes'] },
  ],
  annotations: [
    ['measurement', 'Measurement'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['measurements', 'Measurements', [0]],
    ['warnings', 'Warnings', [1]],
  ],
};
