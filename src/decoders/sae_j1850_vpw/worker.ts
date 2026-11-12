import { SaeJ1850VpwDecoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, SaeJ1850VpwDecoder, 'logic');
