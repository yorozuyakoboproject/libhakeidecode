import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'atsha204a',
  name: 'ATSHA204A *',
  longname: 'Microchip ATSHA204A',
  desc: 'Microchip ATSHA204A family crypto authentication protocol.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Security/crypto', 'IC', 'Memory'],
  annotations: [
    ['waddr', 'Word address'],
    ['count', 'Count'],
    ['opcode', 'Opcode'],
    ['param1', 'Param1'],
    ['param2', 'Param2'],
    ['data', 'Data'],
    ['crc', 'CRC'],
    ['status', 'Status'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['frame', 'Frames', [0, 1, 2, 3, 4, 5, 6]],
    ['status-vals', 'Status', [7]],
    ['warnings', 'Warnings', [8]],
  ],
};
