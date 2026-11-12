import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'x2444m',
  name: 'X2444M/P *',
  longname: 'Xicor X2444M/P',
  desc: 'Xicor X2444M/P nonvolatile static RAM protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Memory'],
  annotations: [
    ['wrds', 'Write disable'],
    ['sto', 'Store RAM data in EEPROM'],
    ['sleep', 'Enter sleep mode'],
    ['write', 'Write data into RAM'],
    ['wren', 'Write enable'],
    ['rcl', 'Recall EEPROM data into RAM'],
    ['read', 'Data read from RAM'],
  ],
};
