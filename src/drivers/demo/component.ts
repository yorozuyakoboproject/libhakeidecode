import type { DriverDefinition } from '../definition.js';
import { DEMO_DEVICE_DESCRIPTOR } from './descriptor.js';
import { messages } from './i18n.js';

export const component = { descriptor: DEMO_DEVICE_DESCRIPTOR, messages } satisfies DriverDefinition;
