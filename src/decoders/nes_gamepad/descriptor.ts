import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'nes_gamepad',
  name: 'NES gamepad *',
  longname: 'Nintendo Entertainment System gamepad',
  desc: 'NES gamepad button states.',
  inputs: ['spi'],
  outputs: [],
  tags: ['Retro computing'],
  options: [{ id: 'variant', desc: 'Gamepad variant', default: 'Standard gamepad', values: ['Standard gamepad'] }],
  annotations: [
    ['button', 'Button state'],
    ['no-press', 'No button press'],
    ['not-connected', 'Gamepad unconnected'],
  ],
  annotationRows: [
    ['buttons', 'Button states', [0]],
    ['no-presses', 'No button presses', [1]],
    ['not-connected-vals', 'Gamepad unconnected', [2]],
  ],
};
