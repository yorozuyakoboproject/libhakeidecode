import { hasBuiltinDecoderWorker, loadBuiltinDecoderWorker } from '../generated/decoder-workers.js';
import type { DecoderWorkerDefinition } from './definition.js';

const builtins = new Map<string, DecoderWorkerDefinition>();
const builtinPending = new Map<string, Promise<DecoderWorkerDefinition | undefined>>();
const dynamic = new Map<string, DecoderWorkerDefinition>();

export function registerDecoderWorker(definition: DecoderWorkerDefinition): void {
  dynamic.set(definition.id, definition);
}

export function unregisterDecoderWorker(id: string): void {
  dynamic.delete(id);
}

export function hasDecoderWorker(id: string): boolean {
  return dynamic.has(id) || builtins.has(id) || hasBuiltinDecoderWorker(id);
}

export async function ensureBuiltinDecoderWorker(id: string): Promise<DecoderWorkerDefinition | undefined> {
  const cached = builtins.get(id);
  if (cached) return cached;
  if (!hasBuiltinDecoderWorker(id)) return undefined;
  let pending = builtinPending.get(id);
  if (!pending) {
    pending = loadBuiltinDecoderWorker(id)
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

export function decoderWorkerDefinition(id: string): DecoderWorkerDefinition {
  const definition = dynamic.get(id) ?? builtins.get(id);
  if (!definition) throw new Error('Unknown decoder: ' + id);
  return definition;
}
