import { Em4305Decoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, Em4305Decoder, 'logic');
