import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'counter',
  name: 'Counter *',
  longname: 'Edge counter',
  desc: 'Count the number of edges in a signal.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Util'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  optionalChannels: [{ id: 'reset', name: 'Reset', desc: 'Reset line' }],
  options: [
    { id: 'data_edge', desc: 'Edges to count (data)', default: 'any', values: ['any', 'rising', 'falling'] },
    { id: 'divider', desc: 'Count divider (word width)', default: 0 },
    {
      id: 'reset_edge',
      desc: 'Edge which clears counters (reset)',
      default: 'falling',
      values: ['any', 'rising', 'falling'],
    },
    { id: 'edge_off', desc: 'Edge counter value after start/reset', default: 0 },
    { id: 'word_off', desc: 'Word counter value after start/reset', default: 0 },
    { id: 'dead_cycles', desc: 'Ignore this many edges after reset', default: 0 },
    { id: 'start_with_reset', desc: 'Assume decode starts with reset', default: 'no', values: ['no', 'yes'] },
  ],
  annotations: [
    ['edge_count', 'Edge count'],
    ['word_count', 'Word count'],
    ['word_reset', 'Word reset'],
  ],
  annotationRows: [
    ['edge_counts', 'Edges', [0]],
    ['word_counts', 'Words', [1]],
    ['word_resets', 'Word resets', [2]],
  ],
};
