import { createEncoder as createLinkEncoder } from '../onewire_link/encoder.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { OnewireOperation } from '../onewire_link/generator.js';
import type { Ds243xCase } from './generator.js';

export function createEncoder(config: Ds243xCase): WaveformEncoder<OnewireOperation> {
  return createLinkEncoder(config);
}
