import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'arm_tpiu',
  name: 'ARM TPIU *',
  longname: 'ARM Trace Port Interface Unit',
  desc: 'Filter TPIU formatted trace data into separate streams.',
  inputs: ['uart'],
  outputs: ['uart'],
  tags: ['Debug/trace'],
  options: [
    { id: 'stream', desc: 'Stream index', default: 1 },
    { id: 'sync_offset', desc: 'Initial sync offset', default: 0 },
  ],
  annotations: [
    ['stream', 'Current stream'],
    ['data', 'Stream data'],
  ],
  annotationRows: [
    ['streams', 'Current streams', [0]],
    ['data-vals', 'Stream data', [1]],
  ],
};
