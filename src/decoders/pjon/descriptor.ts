import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'pjon',
  name: 'PJON *',
  longname: 'PJON',
  desc: 'The PJON protocol.',
  inputs: ['pjon_link'],
  outputs: [],
  tags: ['Embedded/industrial'],
  annotations: [
    ['rx_info', 'Receiver ID'],
    ['hdr_cfg', 'Header config'],
    ['pkt_len', 'Packet length'],
    ['meta_crc', 'Meta CRC'],
    ['tx_info', 'Sender ID'],
    ['port', 'Service ID'],
    ['pkt_id', 'Packet ID'],
    ['anon', 'Anonymous data'],
    ['payload', 'Payload'],
    ['end_crc', 'End CRC'],
    ['syn_rsp', 'Sync response'],
    ['relation', 'Relation'],
    ['warning', 'Warning'],
  ],
  annotationRows: [
    ['fields', 'Fields', [0, 1, 2, 3, 4, 5, 7, 8, 9, 10]],
    ['relations', 'Relations', [11]],
    ['warnings', 'Warnings', [12]],
  ],
};
