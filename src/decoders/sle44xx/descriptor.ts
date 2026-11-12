import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'sle44xx',
  name: 'SLE 44xx *',
  longname: 'SLE44xx memory card',
  desc: 'SLE 4418/28/32/42 memory card serial protocol',
  inputs: ['logic'],
  outputs: [],
  tags: ['Memory'],
  channels: [
    { id: 'rst', name: 'RST', desc: 'Reset line' },
    { id: 'clk', name: 'CLK', desc: 'Clock line' },
    { id: 'io', name: 'I/O', desc: 'I/O data line' },
  ],
  annotations: [
    ['reset_sym', 'Reset Symbol'],
    ['intr_sym', 'Interrupt Symbol'],
    ['start_sym', 'Start Symbol'],
    ['stop_sym', 'Stop Symbol'],
    ['bit_sym', 'Bit Symbol'],
    ['atr_byte', 'ATR Byte'],
    ['cmd_byte', 'Command Byte'],
    ['out_byte', 'Outgoing Byte'],
    ['proc_byte', 'Processing Byte'],
    ['atr_data', 'ATR data'],
    ['cmd_data', 'Command data'],
    ['out_data', 'Outgoing data'],
    ['proc_data', 'Processing data'],
  ],
  annotationRows: [
    ['symbols', 'Symbols', [0, 1, 2, 3, 4]],
    ['fields', 'Fields', [5, 6, 7, 8]],
    ['operations', 'Operations', [9, 10, 11, 12]],
  ],
  binary: [['bytes', 'Bytes']],
};
