import { createStandardWorker } from '../standard-worker.js';
import { descriptor } from './descriptor.js';
import { IrIrmpDecoder } from './index.js';

export const worker = createStandardWorker(descriptor, IrIrmpDecoder, 'logic');
