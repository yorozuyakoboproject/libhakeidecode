import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'am230x',
  name: 'AM230x *',
  longname: 'Aosong AM230x/DHTxx/RHTxx',
  desc: 'Aosong AM230x/DHTxx/RHTxx humidity/temperature sensor.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IC', 'Sensor'],
  channels: [{ id: 'sda', name: 'SDA', desc: 'Single wire serial data line' }],
  options: [{ id: 'device', desc: 'Device type', default: 'am230x', values: ['am230x/rht', 'dht11'] }],
  annotations: [
    ['start', 'Start'],
    ['response', 'Response'],
    ['bit', 'Bit'],
    ['end', 'End'],
    ['byte', 'Byte'],
    ['humidity', 'Relative humidity'],
    ['temperature', 'Temperature'],
    ['checksum', 'Checksum'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1, 2, 3]],
    ['bytes', 'Bytes', [4]],
    ['results', 'Results', [5, 6, 7]],
  ],
};
