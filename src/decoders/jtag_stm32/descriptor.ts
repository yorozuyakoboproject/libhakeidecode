import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'jtag_stm32',
  name: 'JTAG / STM32 *',
  longname: 'Joint Test Action Group / ST STM32',
  desc: 'ST STM32-specific JTAG protocol.',
  inputs: ['jtag'],
  outputs: [],
  tags: ['Debug/trace'],
  annotations: [
    ['item', 'Item'],
    ['field', 'Field'],
    ['command', 'Command'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['items', 'Items', [0]],
    ['fields', 'Fields', [1]],
    ['commands', 'Commands', [2]],
    ['warnings', 'Warnings', [3]],
  ],
};
