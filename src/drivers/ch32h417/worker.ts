import type { DriverWorkerDefinition } from '../definition.js';
import { CH32H417Device, type H417Identity } from './index.js';
import { descriptor } from './descriptor.js';

export const worker: DriverWorkerDefinition = { id: descriptor().id, createDevice: initialization => new CH32H417Device(initialization as H417Identity | undefined) };
