import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'aud',
  name: 'AUD *',
  longname: 'Advanced User Debugger',
  desc: 'Renesas/Hitachi Advanced User Debugger (AUD) protocol.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Debug/trace'],
  channels: [
    { id: 'audck', name: 'AUDCK', desc: 'AUD clock' },
    { id: 'naudsync', name: 'nAUDSYNC', desc: 'AUD sync' },
    { id: 'audata3', name: 'AUDATA3', desc: 'AUD data line 3' },
    { id: 'audata2', name: 'AUDATA2', desc: 'AUD data line 2' },
    { id: 'audata1', name: 'AUDATA1', desc: 'AUD data line 1' },
    { id: 'audata0', name: 'AUDATA0', desc: 'AUD data line 0' },
  ],
  annotations: [['dest', 'Destination address']],
};
