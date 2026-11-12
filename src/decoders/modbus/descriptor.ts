import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'modbus',
  name: 'Modbus *',
  longname: 'Modbus RTU over RS232/RS485',
  desc: 'Modbus RTU protocol for industrial applications.',
  inputs: ['uart'],
  outputs: ['modbus'],
  tags: ['Embedded/industrial'],
  options: [
    { id: 'scchannel', desc: 'Server -> client channel', default: 'RX', values: ['RX', 'TX'] },
    { id: 'cschannel', desc: 'Client -> server channel', default: 'TX', values: ['RX', 'TX'] },
    { id: 'framegap', desc: 'Inter-frame bit gap', default: 28 },
  ],
  annotations: [
    ['sc-server-id', 'SC server ID'],
    ['sc-function', 'SC function'],
    ['sc-crc', 'SC CRC'],
    ['sc-address', 'SC address'],
    ['sc-data', 'SC data'],
    ['sc-length', 'SC length'],
    ['sc-error', 'SC error'],
    ['cs-server-id', 'CS server ID'],
    ['cs-function', 'CS function'],
    ['cs-crc', 'CS CRC'],
    ['cs-address', 'CS address'],
    ['cs-data', 'CS data'],
    ['cs-length', 'CS length'],
    ['cs-error', 'CS error'],
    ['error-indication', 'Error indication'],
  ],
  annotationRows: [
    ['sc', 'Server->client', [0, 1, 2, 3, 4, 5, 6]],
    ['cs', 'Client->server', [7, 8, 9, 10, 11, 12, 13]],
    ['error-indicators', 'Errors in frame', [14]],
  ],
};
