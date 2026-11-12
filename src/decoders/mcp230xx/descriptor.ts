import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'mcp230xx',
  name: 'MCP230XX *',
  longname: 'Microchip MCP230XX',
  desc: 'MCP230XX 8/16-bit I²C output expanders.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['IC'],
  options: [{ id: 'type', desc: 'Type', default: 'MCP23017', values: ['MCP23008', 'MCP23017'] }],
  annotations: [
    ['register_read', 'Register read'],
    ['register_write', 'Register write'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['regs', 'Registers', [0, 1]],
    ['warnings', 'Warnings', [2]],
  ],
};
