import type { DriverDefinition } from '../definition.js';
import { descriptor } from './descriptor.js';
import { authorize } from './ui.js';
import { messages } from './i18n.js';

export const component = { descriptor: descriptor(), messages, connection: { autoRestore: true, authorize } } satisfies DriverDefinition;
