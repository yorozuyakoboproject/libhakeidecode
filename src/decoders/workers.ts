import { decoderWorkers } from '../generated/decoder-workers.js';
import type { DecoderWorkerDefinition } from './definition.js';

const definitions = new Map(decoderWorkers.map((definition) => [definition.id, definition]));
export function decoderWorkerDefinition(id: string): DecoderWorkerDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error('Unknown decoder: ' + id);
  return definition;
}
