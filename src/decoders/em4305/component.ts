import type { DecoderDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { messages } from './i18n.js';
import { standardUi } from '../standard-component.js';

export const component = {
  descriptor,
  messages,
  ui: standardUi(descriptor),
} satisfies DecoderDefinition;
