import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3, id: 'pwm', name: 'PWM', longname: 'Pulse-width modulation',
  desc: 'Analog level encoded in duty cycle percentage.',
  inputs: ['logic'], outputs: [], tags: ['Encoding'],
  channels: [{ id: 'data', name: 'Data', desc: 'Data line' }],
  options: [{ id: 'polarity', desc: 'Polarity', default: 'active-high', values: ['active-low', 'active-high'] }],
  annotations: [['duty-cycle', 'Duty cycle'], ['period', 'Period'], ['frequency', 'Frequency']],
  annotationRows: [['duty-cycle-vals', 'Duty cycles', [0]], ['periods', 'Periods', [1]], ['frequency-vals', 'Frequencies', [2]]],
  binary: [['raw', 'RAW file']],
};
