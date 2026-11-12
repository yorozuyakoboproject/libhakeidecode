import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'xy2-100',
  name: 'XY2-100 *',
  longname: 'XY2-100(E) and XY-200(E) galvanometer protocol',
  desc: 'Serial protocol for galvanometer positioning in laser systems',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial'],
  channels: [
    { id: 'clk', name: 'CLK', desc: 'Clock' },
    { id: 'sync', name: 'SYNC', desc: 'Sync' },
    { id: 'data', name: 'DATA', desc: 'X, Y or Z axis data' },
  ],
  optionalChannels: [{ id: 'status', name: 'STAT', desc: 'X, Y or Z axis status' }],
  annotations: [
    ['bit', 'Data Bit'],
    ['stat_bit', 'Status Bit'],
    ['type', 'Frame Type'],
    ['command', 'Command'],
    ['parameter', 'Parameter'],
    ['parity', 'Parity'],
    ['position', 'Position'],
    ['status', 'Status'],
    ['warning', 'Human-readable warnings'],
  ],
  annotationRows: [
    ['bits', 'Data Bits', [0]],
    ['stat_bits', 'Status Bits', [1]],
    ['data', 'Data', [2, 3, 4, 5]],
    ['positions', 'Positions', [6]],
    ['statuses', 'Statuses', [7]],
    ['warnings', 'Warnings', [8]],
  ],
};
