import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'tdm_audio',
  name: 'TDM audio *',
  longname: 'Time division multiplex audio',
  desc: 'TDM multi-channel audio protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Audio'],
  channels: [
    { id: 'clock', name: 'Bitclk', desc: 'Data bit clock' },
    { id: 'frame', name: 'Framesync', desc: 'Frame sync' },
    { id: 'data', name: 'Data', desc: 'Serial data' },
  ],
  options: [
    { id: 'bps', desc: 'Bits per sample', default: 16, min: 1, max: 32 },
    { id: 'channels', desc: 'Channels per frame', default: 8, min: 1, max: 8 },
    { id: 'edge', desc: 'Clock edge to sample on', default: 'rising', values: ['rising', 'falling'] },
  ],
  annotations: [
    ['ch0', 'Ch0'],
    ['ch1', 'Ch1'],
    ['ch2', 'Ch2'],
    ['ch3', 'Ch3'],
    ['ch4', 'Ch4'],
    ['ch5', 'Ch5'],
    ['ch6', 'Ch6'],
    ['ch7', 'Ch7'],
  ],
  annotationRows: [
    ['ch0-vals', 'Ch0', [0]],
    ['ch1-vals', 'Ch1', [1]],
    ['ch2-vals', 'Ch2', [2]],
    ['ch3-vals', 'Ch3', [3]],
    ['ch4-vals', 'Ch4', [4]],
    ['ch5-vals', 'Ch5', [5]],
    ['ch6-vals', 'Ch6', [6]],
    ['ch7-vals', 'Ch7', [7]],
  ],
};
