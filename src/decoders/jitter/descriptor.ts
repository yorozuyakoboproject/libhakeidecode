import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'jitter',
  name: 'Jitter *',
  longname: 'Timing jitter calculation',
  desc: 'Retrieves the timing jitter between two digital signals.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Clock/timing', 'Util'],
  channels: [
    { id: 'clk', name: 'Clock', desc: 'Clock reference channel' },
    { id: 'sig', name: 'Resulting signal', desc: 'Resulting signal controlled by the clock' },
  ],
  options: [
    { id: 'clk_polarity', desc: 'Clock edge polarity', default: 'rising', values: ['rising', 'falling', 'both'] },
    {
      id: 'sig_polarity',
      desc: 'Resulting signal edge polarity',
      default: 'rising',
      values: ['rising', 'falling', 'both'],
    },
  ],
  annotations: [
    ['jitter', 'Jitter value'],
    ['clk_miss', 'Clock miss'],
    ['sig_miss', 'Signal miss'],
  ],
  annotationRows: [
    ['jitter_vals', 'Jitter values', [0]],
    ['clk_misses', 'Clock misses', [1]],
    ['sig_misses', 'Signal misses', [2]],
  ],
  binary: [['ascii-float', 'Jitter values as newline-separated ASCII floats']],
};
