import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'usb_request',
  name: 'USB request *',
  longname: 'Universal Serial Bus (LS/FS) transaction/request',
  desc: 'USB (low-speed/full-speed) transaction/request protocol.',
  inputs: ['usb_packet'],
  outputs: ['usb_request'],
  tags: ['PC'],
  options: [
    { id: 'in_request_start', desc: 'Start IN requests on', default: 'submit', values: ['submit', 'first-ack'] },
  ],
  annotations: [
    ['request-setup-read', 'Setup: Device-to-host'],
    ['request-setup-write', 'Setup: Host-to-device'],
    ['request-bulk-read', 'Bulk: Device-to-host'],
    ['request-bulk-write', 'Bulk: Host-to-device'],
    ['error', 'Unexpected packet'],
  ],
  annotationRows: [
    ['request-setup', 'USB SETUP', [0, 1]],
    ['request-in', 'USB BULK IN', [2]],
    ['request-out', 'USB BULK OUT', [3]],
    ['errors', 'Errors', [4]],
  ],
  binary: [['pcap', 'PCAP format']],
};
