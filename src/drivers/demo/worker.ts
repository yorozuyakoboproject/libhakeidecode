import type { DriverWorkerDefinition } from '../definition.js';
import { DemoDevice } from './index.js';
import { DEMO_DEVICE_DESCRIPTOR } from './descriptor.js';

export const worker: DriverWorkerDefinition = { id: DEMO_DEVICE_DESCRIPTOR.id, createDevice: () => new DemoDevice() };
