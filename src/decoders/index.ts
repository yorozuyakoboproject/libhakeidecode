import { decoderDefinitions } from '../generated/decoders.js';
import type { DecoderDefinition } from './definition.js';

export { decoderDefinitions };
const definitions = new Map(decoderDefinitions.map((definition) => [definition.descriptor.id, definition]));
export function decoderDefinition(id: string): DecoderDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error('Unknown decoder: ' + id);
  return definition;
}
export * from './definition.js';
