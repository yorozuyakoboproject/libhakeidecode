import type { ComponentMessages } from '../components.js';
import type { DeviceDescriptor, SampleDevice } from '../libhakei/device.js';

export interface DriverDefinition {
  readonly descriptor: DeviceDescriptor;
  readonly messages: ComponentMessages;
  readonly connection?: { readonly autoRestore: boolean; authorize(initialization?: unknown): Promise<unknown> };
}
export interface DriverWorkerDefinition {
  readonly id: string;
  createDevice(initialization?: unknown): SampleDevice;
}
