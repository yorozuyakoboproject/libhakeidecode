import { Ac97Decoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, Ac97Decoder, 'logic');
