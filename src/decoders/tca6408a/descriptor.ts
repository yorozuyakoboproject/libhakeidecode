import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'tca6408a',
  name: 'TI TCA6408A *',
  longname: 'Texas Instruments TCA6408A',
  desc: 'Texas Instruments TCA6408A 8-bit I²C I/O expander.',
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
    ['p0', 'P-port input/output 0'],
    ['p1', 'P-port input/output 1'],
    ['p2', 'P-port input/output 2'],
    ['p3', 'P-port input/output 3'],
    ['p4', 'P-port input/output 4'],
    ['p5', 'P-port input/output 5'],
    ['p6', 'P-port input/output 6'],
    ['p7', 'P-port input/output 7'],
  ],
};
