import { driverDefinitions as builtinDriverDefinitions } from '../generated/drivers.js';
import type { DriverDefinition } from './definition.js';

export { builtinDriverDefinitions };
export const driverDefinitions: DriverDefinition[] = [...builtinDriverDefinitions];
const definitions = new Map<string, DriverDefinition>(
  builtinDriverDefinitions.map((definition) => [definition.descriptor.id, definition]),
);

function syncArray(): void {
  driverDefinitions.splice(0, driverDefinitions.length, ...definitions.values());
}

export function hasDriverDefinition(id: string): boolean {
  return definitions.has(id);
}

export function driverDefinition(id: string): DriverDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error('Unknown driver: ' + id);
  return definition;
}

export function registerDriverDefinition(definition: DriverDefinition): void {
  definitions.set(definition.descriptor.id, definition);
  syncArray();
}

export function unregisterDriverDefinition(id: string): void {
  if (!definitions.delete(id)) return;
  syncArray();
}

export function clearDriverDefinitions(): void {
  definitions.clear();
  syncArray();
}

export type { DriverDefinition, DriverWorkerDefinition } from './definition.js';
