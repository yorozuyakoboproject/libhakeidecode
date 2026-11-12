import type { WaveformEncoder } from '../../build/roundtrip.js';
import { createEncoder as createMdioEncoder } from '../mdio/encoder.js';
import type { MdioRun } from '../mdio/encoder.js';
import type { CfpCase } from './generator.js';

export function createEncoder(config: CfpCase): WaveformEncoder<MdioRun> {
  return createMdioEncoder(config);
}
