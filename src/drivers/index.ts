import { DemoDevice } from '../libhakei/demo.js';
import type { SampleDevice } from '../libhakei/device.js';
import { CH32H417Device } from './ch32h417/index.js';

export const sampleDevices: readonly SampleDevice[] = [new DemoDevice(), new CH32H417Device()];
