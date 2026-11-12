import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'st25r39xx_spi',
  name: 'ST25R39xx (SPI mode) *',
  longname: 'STMicroelectronics ST25R39xx',
  desc: 'High performance NFC universal device and EMVCo reader protocol.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Wireless/RF'],
  annotations: [
    ['Read', 'Burst register read'],
    ['Write', 'Burst register write'],
    ['ReadB', 'Burst register SpaceB read'],
    ['WriteB', 'Burst register SpaceB write'],
    ['ReadT', 'Burst register Test read'],
    ['WriteT', 'Burst register Test write'],
    ['Cmd', 'Direct command'],
    ['FIFOW', 'FIFO write'],
    ['FIFOR', 'FIFO read'],
    ['status_reg', 'Status register'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['regs', 'Regs', [0, 1, 2, 3, 4, 5]],
    ['cmds', 'Commands', [6]],
    ['data', 'Data', [7, 8]],
    ['status', 'Status register', [9]],
    ['warnings', 'Warnings', [10]],
  ],
};
