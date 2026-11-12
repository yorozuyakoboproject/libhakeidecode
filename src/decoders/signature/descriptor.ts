import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'signature',
  name: 'Signature *',
  longname: 'Signature analysis',
  desc: 'Annotate signature of logic patterns.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Debug/trace', 'Util', 'Encoding'],
  channels: [
    { id: 'start', name: 'START', desc: 'START channel' },
    { id: 'stop', name: 'STOP', desc: 'STOP channel' },
    { id: 'clk', name: 'CLOCK', desc: 'CLOCK channel' },
    { id: 'data', name: 'DATA', desc: 'DATA channel' },
  ],
  options: [
    { id: 'start_edge', desc: 'START edge polarity', default: 'rising', values: ['rising', 'falling'] },
    { id: 'stop_edge', desc: 'STOP edge polarity', default: 'rising', values: ['rising', 'falling'] },
    { id: 'clk_edge', desc: 'CLOCK edge polarity', default: 'falling', values: ['rising', 'falling'] },
    { id: 'annbits', desc: 'Enable bit level annotations', default: 'no', values: ['yes', 'no'] },
  ],
  annotations: [
    ['bit0', 'Bit0'],
    ['bit1', 'Bit1'],
    ['start', 'START'],
    ['stop', 'STOP'],
    ['signature', 'Signature'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2, 3]],
    ['signatures', 'Signatures', [4]],
  ],
};
