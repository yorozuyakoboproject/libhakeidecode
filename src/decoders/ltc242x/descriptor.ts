import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ltc242x',
  name: 'LTC242x *',
  longname: 'Linear Technology LTC242x',
  desc: 'Linear Technology LTC2421/LTC2422 1-/2-channel 20-bit ADC.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Analog/digital'],
  options: [{ id: 'vref', desc: 'Reference voltage (V)', default: 1.5 }],
  annotations: [
    ['ch0_voltage', 'CH0 voltage'],
    ['ch1_voltage', 'CH1 voltage'],
  ],
  annotationRows: [
    ['ch0_voltages', 'CH0 voltages', [0]],
    ['ch1_voltages', 'CH1 voltages', [1]],
  ],
};
