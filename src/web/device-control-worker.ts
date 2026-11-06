import { createDriverDevice } from '../drivers/workers.js';
import { componentFailure } from '../components.js';
import { resolveDeviceConfiguration, validateDeviceConfiguration, type SampleDevice } from '../libhakei/device.js';
import type { DeviceRequest, DeviceResponse, DeviceState } from './device-protocol.js';

type Scope = {
  onmessage: ((event: MessageEvent<DeviceRequest>) => void) | null;
  postMessage(message: DeviceResponse): void;
};
const scope = globalThis as unknown as Scope;
let device: SampleDevice | undefined;
let driverId: string | undefined;
let pending = Promise.resolve();
function state(current: SampleDevice): DeviceState {
  return { descriptor: current.descriptor, connected: current.connected, initialization: current.initialization };
}
scope.onmessage = ({ data }) => {
  pending = pending.then(async () => {
    try {
      if (driverId && driverId !== data.driverId) throw new Error('Device control Worker cannot change drivers');
      if (!device) {
        device = createDriverDevice(data.driverId);
        driverId = data.driverId;
        const current = device;
        current.onConnectionChange = () => scope.postMessage({ type: 'state', state: state(current) });
      }
      let restored: boolean | undefined;
      let description, settings;
      if (data.type === 'restore') restored = (await device.restore?.(data.initialization)) ?? true;
      else if (data.type === 'connect') {
        if (!device.connect) throw new Error('Driver does not support device authorization');
        await device.connect(data.initialization);
      } else if (data.type === 'disconnect') await device.disconnect?.();
      else if (data.type === 'transport') {
        if (data.mode === undefined) await device.refreshTransport?.();
        else await device.setTransport?.(data.mode);
      } else if (data.type === 'configure') settings = resolveDeviceConfiguration(device, data.configuration);
      else if (data.type === 'prepare') {
        await device.refreshTransport?.();
        validateDeviceConfiguration(device, data.configuration);
        const acquisition = device.getAcquisitionDescription(data.configuration);
        if (
          acquisition.layout !== device.layout &&
          !(device.layout === 'multi-rate' && acquisition.layout === 'packed-logic')
        )
          throw new Error('Driver acquisition layout does not match its data source');
        description = { ...acquisition, worker: { driverId: data.driverId, initialization: device.initialization } };
      } else throw new Error('Unknown device control request');
      scope.postMessage({
        type: 'result',
        requestId: data.requestId,
        state: state(device),
        restored,
        settings,
        description,
      });
    } catch (error) {
      if (device) scope.postMessage({ type: 'state', state: state(device) });
      scope.postMessage({ type: 'error', requestId: data.requestId, ...componentFailure(error) });
    }
  });
};
