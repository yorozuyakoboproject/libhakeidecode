import { NumbersAndStateDecoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, NumbersAndStateDecoder, 'logic');
