import type { DecoderDescriptor } from '../../libhakeidecode/types.js';

export const descriptor: DecoderDescriptor = {
  apiVersion: 3,
  id: 'rgb_led_spi',
  name: 'RGB LED (SPI) *',
  longname: 'RGB LED string decoder (SPI)',
  desc: 'RGB LED string protocol (RGB values clocked over SPI).',
  inputs: ['spi'],
  outputs: [],
  tags: ['Display'],
  annotations: [['rgb', 'RGB value']],
};
