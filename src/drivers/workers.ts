import { hasBuiltinDriverWorker, loadBuiltinDriverWorker } from '../generated/driver-workers.js';
import type { SampleDevice } from '../libhakei/device.js';
import type { DriverWorkerDefinition } from './definition.js';

const builtins = new Map<string, DriverWorkerDefinition>();
const builtinPending = new Map<string, Promise<DriverWorkerDefinition | undefined>>();
const dynamic = new Map<string, DriverWorkerDefinition>();

export function registerDriverWorker(definition: DriverWorkerDefinition): void {
  dynamic.set(definition.id, definition);
}

export function unregisterDriverWorker(id: string): void {
  dynamic.delete(id);
}

export function hasDriverWorker(id: string): boolean {
  return dynamic.has(id) || builtins.has(id) || hasBuiltinDriverWorker(id);
}

export async function ensureBuiltinDriverWorker(id: string): Promise<DriverWorkerDefinition | undefined> {
  const cached = builtins.get(id);
  if (cached) return cached;
  if (!hasBuiltinDriverWorker(id)) return undefined;
  let pending = builtinPending.get(id);
  if (!pending) {
    pending = loadBuiltinDriverWorker(id)
      .then((definition) => {
        if (definition) builtins.set(id, definition);
        return definition;
      })
      .finally(() => {
        if (builtinPending.get(id) === pending) builtinPending.delete(id);
      });
    builtinPending.set(id, pending);
  }
  return pending;
}

export function createDriverDevice(id: string, initialization?: unknown): SampleDevice {
  const definition = dynamic.get(id) ?? builtins.get(id);
  if (!definition) throw new Error('Unknown driver: ' + id);
  return definition.createDevice(initialization);
}
