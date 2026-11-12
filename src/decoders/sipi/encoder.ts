import { createEncoder as createLfastEncoder } from '../lfast/encoder.js';
import type { WaveformEncoder } from '../../build/roundtrip.js';
import type { LfastRun } from '../lfast/encoder.js';
import type { SipiCase } from './generator.js';

export function createEncoder(config: SipiCase): WaveformEncoder<LfastRun> {
  return createLfastEncoder(config);
}
