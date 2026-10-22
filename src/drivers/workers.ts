import { driverWorkers } from '../generated/driver-workers.js';
import type { SampleDevice } from '../libhakei/device.js';

const definitions = new Map(driverWorkers.map(definition => [definition.id, definition]));
export function createDriverDevice(id: string, initialization?: unknown): SampleDevice {
  const definition = definitions.get(id);
  if (!definition) throw new Error('Unknown driver: ' + id);
  return definition.createDevice(initialization);
}
