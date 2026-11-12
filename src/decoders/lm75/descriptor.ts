import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'lm75',
  name: 'LM75 *',
  longname: 'National LM75',
  desc: 'National LM75 (and compatibles) temperature sensor.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Sensor'],
  options: [
    { id: 'sensor', desc: 'Sensor type', default: 'lm75', values: ['lm75'] },
    { id: 'resolution', desc: 'Resolution (bits)', default: 9, values: [9, 10, 11, 12] },
  ],
  annotations: [
    ['celsius', 'Temperature / °C'],
    ['kelvin', 'Temperature / Kelvin'],
    ['text-verbose', 'Text (verbose)'],
    ['text', 'Text'],
    ['warning', 'Warning'],
  ],
};
