import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'avr_isp',
  name: 'AVR ISP *',
  longname: 'AVR In-System Programming',
  desc: 'Atmel AVR In-System Programming (ISP) protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Debug/trace'],
  annotations: [
    ['pe', 'Programming enable'],
    ['rsb0', 'Read signature byte 0'],
    ['rsb1', 'Read signature byte 1'],
    ['rsb2', 'Read signature byte 2'],
    ['ce', 'Chip erase'],
    ['rfb', 'Read fuse bits'],
    ['rhfb', 'Read high fuse bits'],
    ['refb', 'Read extended fuse bits'],
    ['rlb', 'Read lock bits'],
    ['reem', 'Read EEPROM memory'],
    ['rp', 'Read program memory'],
    ['lpmp', 'Load program memory page'],
    ['wp', 'Write program memory'],
    ['warning', 'Warning'],
    ['dev', 'Device'],
  ],
  annotationRows: [
    ['commands', 'Commands', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
    ['warnings', 'Warnings', [13]],
    ['devs', 'Devices', [14]],
  ],
};
