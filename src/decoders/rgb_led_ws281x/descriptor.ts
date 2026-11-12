import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'rgb_led_ws281x',
  name: 'RGB LED (WS281x) *',
  longname: 'RGB LED string decoder (WS281x)',
  desc: 'RGB LED string protocol (WS281x).',
  inputs: ['logic'],
  outputs: [],
  tags: ['Display', 'IC'],
  channels: [{ id: 'din', name: 'DIN', desc: 'DIN data line' }],
  options: [
    {
      id: 'wireorder',
      desc: 'colour components order (wire)',
      default: 'GRB',
      values: ['BGR', 'BRG', 'GBR', 'GRB', 'RBG', 'RGB', 'RWBG', 'RGBW'],
    },
    {
      id: 'textorder',
      desc: 'components output order (text)',
      default: 'RGB[W]',
      values: ['wire', 'RGB[W]', 'RGB', 'RGBW', 'RGWB'],
    },
  ],
  annotations: [
    ['bit', 'Bit'],
    ['reset', 'RESET'],
    ['rgb', 'RGB'],
    ['r', 'R'],
    ['g', 'G'],
    ['b', 'B'],
    ['w', 'W'],
  ],
  annotationRows: [
    ['bits', 'Bits', [0, 1]],
    ['rgb-comps', 'RGB components', [3, 4, 5, 6]],
    ['rgb-vals', 'RGB values', [2]],
  ],
};
