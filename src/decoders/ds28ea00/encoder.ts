import { createEncoder as createLinkEncoder } from '../onewire_link/encoder.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { OnewireOperation } from '../onewire_link/generator.js';
import type { Ds28ea00Case } from './generator.js';

export function createEncoder(config: Ds28ea00Case): WaveformEncoder<OnewireOperation> {
  return createLinkEncoder(config);
}
