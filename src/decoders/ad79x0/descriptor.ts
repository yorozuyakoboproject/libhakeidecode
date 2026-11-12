import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ad79x0',
  name: 'AD79x0 *',
  longname: 'Analog Devices AD79x0',
  desc: 'Analog Devices AD7910/AD7920 12-bit ADC.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Analog/digital'],
  options: [{ id: 'vref', desc: 'Reference voltage (V)', default: 1.5 }],
  annotations: [
    ['mode', 'Mode'],
    ['voltage', 'Voltage'],
    ['validation', 'Validation'],
  ],
  annotationRows: [
    ['modes', 'Modes', [0]],
    ['voltages', 'Voltages', [1]],
    ['data_validation', 'Data validation', [2]],
  ],
};
