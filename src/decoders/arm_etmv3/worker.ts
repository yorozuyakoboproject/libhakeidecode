import { ArmEtmv3Decoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, ArmEtmv3Decoder, 'protocol');
