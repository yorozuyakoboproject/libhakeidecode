import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'nrf24l01',
  name: 'nRF24L01(+) *',
  longname: 'Nordic Semiconductor nRF24L01(+)',
  desc: '2.4GHz RF transceiver chip.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Wireless/RF'],
  options: [{ id: 'chip', desc: 'Chip type', default: 'nrf24l01', values: ['nrf24l01', 'xn297'] }],
  annotations: [
    ['cmd', 'Command'],
    ['tx-data', 'Payload'],
    ['register', 'Register read'],
    ['rx-data', 'Payload read'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['commands', 'Commands', [0, 1]],
    ['responses', 'Responses', [2, 3]],
    ['warnings', 'Warnings', [4]],
  ],
};
