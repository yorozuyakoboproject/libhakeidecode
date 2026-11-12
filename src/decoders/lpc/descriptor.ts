import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'lpc',
  name: 'LPC *',
  longname: 'Low Pin Count',
  desc: 'Protocol for low-bandwidth devices on PC mainboards.',
  inputs: ['logic'],
  outputs: [],
  tags: ['PC'],
  channels: [
    { id: 'lframe', name: 'LFRAME#', desc: 'Frame' },
    { id: 'lclk', name: 'LCLK', desc: 'Clock' },
    { id: 'lad0', name: 'LAD[0]', desc: 'Addr/control/data 0' },
    { id: 'lad1', name: 'LAD[1]', desc: 'Addr/control/data 1' },
    { id: 'lad2', name: 'LAD[2]', desc: 'Addr/control/data 2' },
    { id: 'lad3', name: 'LAD[3]', desc: 'Addr/control/data 3' },
  ],
  optionalChannels: [
    { id: 'lreset', name: 'LRESET#', desc: 'Reset' },
    { id: 'ldrq', name: 'LDRQ#', desc: 'Encoded DMA / bus master request' },
    { id: 'serirq', name: 'SERIRQ', desc: 'Serialized IRQ' },
    { id: 'clkrun', name: 'CLKRUN#', desc: 'Clock run' },
    { id: 'lpme', name: 'LPME#', desc: 'LPC power management event' },
    { id: 'lpcpd', name: 'LPCPD#', desc: 'Power down' },
    { id: 'lsmi', name: 'LSMI#', desc: 'System Management Interrupt' },
  ],
  annotations: [
    ['warning', 'Warning'],
    ['start', 'Start'],
    ['cycle-type', 'Cycle-type/direction'],
    ['addr', 'Address'],
    ['tar1', 'Turn-around cycle 1'],
    ['sync', 'Sync'],
    ['data', 'Data'],
    ['tar2', 'Turn-around cycle 2'],
  ],
  annotationRows: [
    ['data-vals', 'Data', [1, 2, 3, 4, 5, 6, 7]],
    ['warnings', 'Warnings', [0]],
  ],
};
