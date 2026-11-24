import { decoderDefinitions as builtinDecoderDefinitions } from '../generated/decoders.js';
import type { DecoderDefinition } from './definition.js';

export { builtinDecoderDefinitions };
export const decoderDefinitions: DecoderDefinition[] = [...builtinDecoderDefinitions];
const definitions = new Map<string, DecoderDefinition>(
  builtinDecoderDefinitions.map((definition) => [definition.descriptor.id, definition]),
);

function syncArray(): void {
  decoderDefinitions.splice(0, decoderDefinitions.length, ...definitions.values());
}

export function hasDecoderDefinition(id: string): boolean {
  return definitions.has(id);
}

export function decoderDefinition(id: string): DecoderDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error('Unknown decoder: ' + id);
  return definition;
}

export function registerDecoderDefinition(definition: DecoderDefinition): void {
  definitions.set(definition.descriptor.id, definition);
  syncArray();
}

export function unregisterDecoderDefinition(id: string): void {
  if (!definitions.delete(id)) return;
  syncArray();
}

export function clearDecoderDefinitions(): void {
  definitions.clear();
  syncArray();
}

export * from './definition.js';
