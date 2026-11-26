import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ir-nec',
  name: 'IR NEC',
  longname: 'NEC infrared remote control',
  desc: 'Pulse-distance infrared remote-control protocol.',
  inputs: ['logic'],
  outputs: ['ir-nec'],
  tags: ['Consumer'],
  channels: [{ id: 'ir', name: 'IR', desc: 'Infrared input or demodulated receiver output' }],
  options: [
    {
      id: 'polarity',
      desc: 'Input polarity',
      default: 'active-low',
      values: ['auto', 'active-low', 'active-high'],
    },
    { id: 'carrier_frequency', desc: 'Carrier frequency', default: 0, min: 0, required: true },
    { id: 'extended', desc: 'Extended address', default: 'no', values: ['yes', 'no'] },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['agc-pulse', 'AGC pulse'],
    ['longpause', 'Long pause'],
    ['shortpause', 'Short pause'],
    ['stop-bit', 'Stop bit'],
    ['leader-code', 'Leader code'],
    ['addr', 'Address'],
    ['addr-inv', 'Address#'],
    ['cmd', 'Command'],
    ['cmd-inv', 'Command#'],
    ['repeat-code', 'Repeat code'],
    ['remote', 'Remote'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2, 3, 4]],
    ['fields', 'Fields', [5, 6, 7, 8, 9, 10]],
    ['remote-vals', 'Remote', [11]],
    ['warnings', 'Warnings', [12]],
  ],
};
