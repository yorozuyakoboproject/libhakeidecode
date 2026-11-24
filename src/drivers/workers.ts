import { driverWorkers } from '../generated/driver-workers.js';
import type { SampleDevice } from '../libhakei/device.js';
import type { DriverWorkerDefinition } from './definition.js';

const builtins = new Map(driverWorkers.map((definition) => [definition.id, definition]));
const dynamic = new Map<string, DriverWorkerDefinition>();

export function registerDriverWorker(definition: DriverWorkerDefinition): void {
  dynamic.set(definition.id, definition);
}

export function unregisterDriverWorker(id: string): void {
  dynamic.delete(id);
}

export function hasDriverWorker(id: string): boolean {
  return dynamic.has(id) || builtins.has(id);
}

export function createDriverDevice(id: string, initialization?: unknown): SampleDevice {
  const definition = dynamic.get(id) ?? builtins.get(id);
  if (!definition) throw new Error('Unknown driver: ' + id);
  return definition.createDevice(initialization);
}
