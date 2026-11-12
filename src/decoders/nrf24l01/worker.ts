import { Nrf24l01Decoder } from './index.js';
import { descriptor } from './descriptor.js';
import { createStandardWorker } from '../standard-worker.js';

export const worker = createStandardWorker(descriptor, Nrf24l01Decoder, 'protocol');
