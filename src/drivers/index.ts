import type { SampleDevice } from '../libhakei/device.js';
import { CH32H417Device } from './ch32h417/index.js';
import { DemoDevice } from './demo/index.js';

export * from './demo/index.js';
export const sampleDevices: readonly SampleDevice[] = [new DemoDevice(), new CH32H417Device()];
