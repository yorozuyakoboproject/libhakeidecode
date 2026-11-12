import { Atsha204aDecoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, Atsha204aDecoder, 'protocol');
