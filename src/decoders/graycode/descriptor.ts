import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'graycode',
  name: 'Gray code *',
  longname: 'Gray code and rotary encoder',
  desc: 'Accumulate rotary encoder increments, provide statistics.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Encoding'],
  optionalChannels: [
    { id: 'd0', name: 'D0', desc: 'Data line 0' },
    { id: 'd1', name: 'D1', desc: 'Data line 1' },
    { id: 'd2', name: 'D2', desc: 'Data line 2' },
    { id: 'd3', name: 'D3', desc: 'Data line 3' },
    { id: 'd4', name: 'D4', desc: 'Data line 4' },
    { id: 'd5', name: 'D5', desc: 'Data line 5' },
    { id: 'd6', name: 'D6', desc: 'Data line 6' },
    { id: 'd7', name: 'D7', desc: 'Data line 7' },
  ],
  options: [
    { id: 'edges', desc: 'Edges per rotation', default: 0 },
    { id: 'avg_period', desc: 'Averaging period', default: 10 },
  ],
  annotations: [
    ['phase', 'Phase'],
    ['increment', 'Increment'],
    ['count', 'Count'],
    ['turn', 'Turn'],
    ['interval', 'Interval'],
    ['average', 'Average'],
    ['rpm', 'Rate'],
  ],
  annotationRows: [
    ['phases', 'Phases', [0]],
    ['increments', 'Increments', [1]],
    ['counts', 'Counts', [2]],
    ['turns', 'Turns', [3]],
    ['intervals', 'Intervals', [4]],
    ['averages', 'Averages', [5]],
    ['rpms', 'Rates', [6]],
  ],
};
