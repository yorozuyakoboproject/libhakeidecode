import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'tlc5620',
  name: 'TI TLC5620 *',
  longname: 'Texas Instruments TLC5620',
  desc: 'Texas Instruments TLC5620 8-bit quad DAC.',
  inputs: ['logic'],
  outputs: [],
  tags: ['IC', 'Analog/digital'],
  channels: [
    { id: 'clk', name: 'CLK', desc: 'Serial interface clock' },
    { id: 'data', name: 'DATA', desc: 'Serial interface data' },
  ],
  optionalChannels: [
    { id: 'load', name: 'LOAD', desc: 'Serial interface load control' },
    { id: 'ldac', name: 'LDAC', desc: 'Load DAC' },
  ],
  options: [
    { id: 'vref_a', desc: 'Reference voltage DACA (V)', default: 3.3 },
    { id: 'vref_b', desc: 'Reference voltage DACB (V)', default: 3.3 },
    { id: 'vref_c', desc: 'Reference voltage DACC (V)', default: 3.3 },
    { id: 'vref_d', desc: 'Reference voltage DACD (V)', default: 3.3 },
  ],
  annotations: [
    ['dac-select', 'DAC select'],
    ['gain', 'Gain'],
    ['value', 'DAC value'],
    ['data-latch', 'Data latch point'],
    ['ldac-fall', 'LDAC falling edge'],
    ['bit', 'Bit'],
    ['reg-write', 'Register write'],
    ['voltage-update', 'Voltage update'],
    ['voltage-update-all', 'Voltage update (all DACs)'],
    ['invalid-cmd', 'Invalid command'],
  ],
  annotationRows: [
    ['bits', 'Bits', [5]],
    ['fields', 'Fields', [0, 1, 2]],
    ['registers', 'Registers', [6, 7]],
    ['voltage-updates', 'Voltage updates', [8]],
    ['events', 'Events', [3, 4]],
    ['errors', 'Errors', [9]],
  ],
};
