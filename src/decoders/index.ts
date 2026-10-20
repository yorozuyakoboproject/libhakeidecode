import { pwmDefinition } from './pwm/definition.js';
import { uartDefinition } from './uart/definition.js';
import type { DecoderDefinition } from './definition.js';

export const decoderDefinitions: readonly DecoderDefinition[] = [uartDefinition, pwmDefinition];
const definitions = new Map(decoderDefinitions.map(definition => [definition.decoder.descriptor.id, definition]));

export function decoderDefinition(id: string): DecoderDefinition {
  const definition = definitions.get(id);
  if (!definition) throw new Error('Unknown decoder: ' + id);
  return definition;
}

export * from './definition.js';
