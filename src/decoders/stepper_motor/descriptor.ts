import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'stepper_motor',
  name: 'Stepper motor *',
  longname: 'Stepper motor position / speed',
  desc: 'Absolute position and movement speed from step/dir.',
  inputs: ['logic'],
  outputs: [],
  tags: ['Embedded/industrial'],
  channels: [
    { id: 'step', name: 'Step', desc: 'Step pulse' },
    { id: 'dir', name: 'Direction', desc: 'Direction select' },
  ],
  options: [
    { id: 'unit', desc: 'Unit', default: 'steps', values: ['steps', 'mm'] },
    { id: 'steps_per_mm', desc: 'Steps per mm', default: 100.0 },
  ],
  annotations: [
    ['speed', 'Speed'],
    ['position', 'Position'],
  ],
  annotationRows: [
    ['speeds', 'Speeds', [0]],
    ['positions', 'Positions', [1]],
  ],
};
