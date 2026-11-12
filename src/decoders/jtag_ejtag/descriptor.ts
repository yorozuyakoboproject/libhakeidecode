import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'jtag_ejtag',
  name: 'JTAG / EJTAG *',
  longname: 'Joint Test Action Group / EJTAG (MIPS)',
  desc: 'MIPS EJTAG protocol.',
  inputs: ['jtag'],
  outputs: [],
  tags: ['Debug/trace'],
  annotations: [
    ['instruction', 'Instruction'],
    ['reset', 'RESET'],
    ['device_id', 'DEVICE_ID'],
    ['implementation', 'IMPLEMENTATION'],
    ['data', 'DATA'],
    ['address', 'ADDRESS'],
    ['control', 'CONTROL'],
    ['fastdata', 'FASTDATA'],
    ['pc_sample', 'PC_SAMPLE'],
    ['bypass', 'BYPASS'],
    ['control_field_in', 'Control field in'],
    ['control_field_out', 'Control field out'],
    ['pracc', 'PrAcc'],
  ],
  annotationRows: [
    ['instructions', 'Instructions', [0]],
    ['control_fields_in', 'Control fields in', [10]],
    ['control_fields_out', 'Control fields out', [11]],
    ['regs', 'Registers', [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ['pracc-vals', 'PrAcc', [12]],
  ],
};
