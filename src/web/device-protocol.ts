import type {
  AcquisitionDescription,
  DeviceConfiguration,
  DeviceConfigurationState,
  DeviceDescriptor,
} from '../libhakei/device.js';
import type { ComponentFailure } from '../components.js';

export type WorkerAcquisitionDescription = AcquisitionDescription & {
  readonly worker: { readonly driverId: string; readonly initialization?: unknown };
};
export interface DeviceControl {
  readonly descriptor: DeviceDescriptor;
  readonly connected?: boolean;
  onConnectionChange: (() => void) | null;
  restore(): Promise<boolean>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  configure(configuration: DeviceConfiguration): Promise<DeviceConfigurationState>;
  prepare(configuration: DeviceConfiguration): Promise<WorkerAcquisitionDescription>;
}
export interface DeviceState {
  readonly descriptor: DeviceDescriptor;
  readonly connected?: boolean;
  readonly initialization?: unknown;
}
export type DeviceCommand =
  | { readonly type: 'restore' | 'connect'; readonly initialization?: unknown }
  | { readonly type: 'disconnect' }
  | { readonly type: 'configure' | 'prepare'; readonly configuration: DeviceConfiguration };
export type DeviceRequest = DeviceCommand & { readonly requestId: number; readonly driverId: string };
export type DeviceResponse =
  | { readonly type: 'state'; readonly state: DeviceState }
  | {
      readonly type: 'result';
      readonly requestId: number;
      readonly state: DeviceState;
      readonly restored?: boolean;
      readonly settings?: DeviceConfigurationState;
      readonly description?: WorkerAcquisitionDescription;
    }
  | ({ readonly type: 'error'; readonly requestId: number } & ComponentFailure);
