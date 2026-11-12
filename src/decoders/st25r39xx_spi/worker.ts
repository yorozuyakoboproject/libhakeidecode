import { St25r39xxSpiDecoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, St25r39xxSpiDecoder, 'protocol');
