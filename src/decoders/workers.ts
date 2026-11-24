import { decoderWorkers } from '../generated/decoder-workers.js';
import type { DecoderWorkerDefinition } from './definition.js';

const builtins = new Map(decoderWorkers.map((definition) => [definition.id, definition]));
const dynamic = new Map<string, DecoderWorkerDefinition>();

export function registerDecoderWorker(definition: DecoderWorkerDefinition): void {
  dynamic.set(definition.id, definition);
}

export function unregisterDecoderWorker(id: string): void {
  dynamic.delete(id);
}

export function hasDecoderWorker(id: string): boolean {
  return dynamic.has(id) || builtins.has(id);
}

export function decoderWorkerDefinition(id: string): DecoderWorkerDefinition {
  const definition = dynamic.get(id) ?? builtins.get(id);
  if (!definition) throw new Error('Unknown decoder: ' + id);
  return definition;
}
