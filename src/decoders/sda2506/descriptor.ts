import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'sda2506',
  name: 'SDA2506 *',
  longname: 'Siemens SDA 2506-5',
  desc: 'Serial nonvolatile 1-Kbit EEPROM.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IC', 'Memory'],
  channels: [
    { id: 'clk', name: 'CLK', desc: 'Clock' },
    { id: 'd', name: 'DATA', desc: 'Data' },
    { id: 'ce', name: 'CE#', desc: 'Chip-enable' },
  ],
  annotations: [
    ['cmdbit', 'Command bit'],
    ['databit', 'Data bit'],
    ['cmd', 'Command'],
    ['databyte', 'Data byte'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1]],
    ['data', 'Data', [3]],
    ['commands', 'Commands', [2]],
    ['warnings', 'Warnings', [4]],
  ],
};
