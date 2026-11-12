import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'pca9571',
  name: 'PCA9571 *',
  longname: 'NXP PCA9571',
  desc: 'NXP PCA9571 8-bit I²C output expander.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Embedded/industrial', 'IC'],
  annotations: [
    ['register', 'Register type'],
    ['value', 'Register value'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['regs', 'Registers', [0, 1]],
    ['warnings', 'Warnings', [2]],
  ],
  logicOutputChannels: [
    ['p0', 'P0'],
    ['p1', 'P1'],
    ['p2', 'P2'],
    ['p3', 'P3'],
    ['p4', 'P4'],
    ['p5', 'P5'],
    ['p6', 'P6'],
    ['p7', 'P7'],
  ],
};
