import { RgbLedWs281xDecoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, RgbLedWs281xDecoder, 'logic');
