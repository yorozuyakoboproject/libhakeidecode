import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'timing',
  name: 'Timing *',
  longname: 'Timing calculation with frequency and averaging',
  desc: 'Calculate time between edges.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Clock/timing', 'Util'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  options: [
    { id: 'avg_period', desc: 'Averaging period', default: 100 },
    { id: 'edge', desc: 'Edges to check', default: 'any', values: ['any', 'rising', 'falling'] },
    { id: 'delta', desc: 'Show delta from last', default: 'no', values: ['yes', 'no'] },
    {
      id: 'format',
      desc: "Format of 'time' annotation",
      default: 'full',
      values: ['full', 'terse-auto', 'terse-s', 'terse-ms', 'terse-us', 'terse-ns', 'terse-ps', 'samples'],
    },
  ],
  annotations: [
    ['time', 'Time'],
    ['terse', 'Terse'],
    ['average', 'Average'],
    ['delta', 'Delta'],
  ],
  annotationRows: [
    ['times', 'Times', [0, 1]],
    ['averages', 'Averages', [2]],
    ['deltas', 'Deltas', [3]],
  ],
};
