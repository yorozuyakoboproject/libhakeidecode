import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'nrf905',
  name: 'nRF905 *',
  longname: 'Nordic Semiconductor nRF905',
  desc: '433/868/933MHz transceiver chip.',
  inputs: ['spi'],
  outputs: [],
  tags: ['IC', 'Wireless/RF'],
  annotations: [
    ['cmd', 'Command sent to the device'],
    ['reg-write', 'Config register written to the device'],
    ['reg-read', 'Config register read from the device'],
    ['tx-data', 'Payload sent to the device'],
    ['rx-data', 'Payload read from the device'],
    ['resp', 'Response to commands received from the device'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['commands', 'Commands', [0]],
    ['responses', 'Responses', [5]],
    ['registers', 'Registers', [1, 2]],
    ['tx', 'Transmitted data', [3]],
    ['rx', 'Received data', [4]],
    ['warnings', 'Warnings', [6]],
  ],
};
