import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'nunchuk',
  name: 'Nunchuk *',
  longname: 'Nintendo Wii Nunchuk',
  desc: 'Nintendo Wii Nunchuk controller protocol.',
  inputs: ['i2c'],
  outputs: [],
  tags: ['Sensor'],
  annotations: [
    ['reg-0x00', 'Register 0x00'],
    ['reg-0x01', 'Register 0x01'],
    ['reg-0x02', 'Register 0x02'],
    ['reg-0x03', 'Register 0x03'],
    ['reg-0x04', 'Register 0x04'],
    ['reg-0x05', 'Register 0x05'],
    ['bit-bz', 'BZ bit'],
    ['bit-bc', 'BC bit'],
    ['bit-ax', 'AX bits'],
    ['bit-ay', 'AY bits'],
    ['bit-az', 'AZ bits'],
    ['nunchuk-write', 'Nunchuk write'],
    ['cmd-init', 'Init command'],
    ['summary', 'Summary'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['regs', 'Registers', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
    ['summaries', 'Summaries', [13]],
    ['warnings', 'Warnings', [14]],
  ],
};
