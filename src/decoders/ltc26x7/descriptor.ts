import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'ltc26x7',
  name: 'LTC26x7 *',
  longname: 'Linear Technology LTC26x7',
  desc: 'Linear Technology LTC26x7 16-/14-/12-bit rail-to-rail DACs.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['IC', 'Analog/digital'],
  options: [
    { id: 'chip', desc: 'Chip', default: 'ltc2607', values: ['ltc2607', 'ltc2617', 'ltc2627'] },
    { id: 'vref', desc: 'Reference voltage (V)', default: 1.5 },
  ],
  annotations: [
    ['slave_addr', 'Slave address'],
    ['command', 'Command'],
    ['address', 'Address'],
    ['dac_a_voltage', 'DAC A voltage'],
    ['dac_b_voltage', 'DAC B voltage'],
  ],
  annotationRows: [
    ['addr_cmd', 'Address/command', [0, 1, 2]],
    ['dac_a_voltages', 'DAC A voltages', [3]],
    ['dac_b_voltages', 'DAC B voltages', [4]],
  ],
};
