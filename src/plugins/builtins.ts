import { builtinDecoderDefinitions } from '../decoders/index.js';
import { builtinDriverDefinitions } from '../drivers/index.js';
import type { BuiltinPluginDefinition } from '../kernel/types.js';
import { pluginManagerPlugin } from './plugin-manager.js';
import { registryPlugin } from './registry.js';
import { shellPlugin } from './shell.js';
import { workbenchPlugin } from './workbench.js';

const builtinDriverPlugins: BuiltinPluginDefinition[] = builtinDriverDefinitions.map((definition) => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: `driver.${definition.descriptor.id}`,
    name: definition.descriptor.name,
    version: '1.0.0',
    kind: 'driver',
    entry: `${definition.descriptor.id}.js`,
    workerEntry: `${definition.descriptor.id}.worker.js`,
    inject: ['componentRegistry'],
    optional: [],
    provides: [],
    contracts: { componentRegistry: 1 },
    order: 30,
    description: definition.descriptor.name,
  },
  load: () => ({ component: definition }),
}));

const builtinDecoderPlugins: BuiltinPluginDefinition[] = builtinDecoderDefinitions.map((definition) => ({
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: `decoder.${definition.descriptor.id}`,
    name: definition.descriptor.name ?? definition.descriptor.id,
    version: '1.0.0',
    kind: 'decoder',
    entry: `${definition.descriptor.id}.js`,
    workerEntry: `${definition.descriptor.id}.worker.js`,
    inject: ['componentRegistry'],
    optional: [],
    provides: [],
    contracts: { componentRegistry: 1 },
    order: 40,
    description: definition.descriptor.desc ?? definition.ui.description ?? '',
  },
  load: () => ({ component: definition }),
}));

export const builtinPlugins: readonly BuiltinPluginDefinition[] = [
  registryPlugin,
  ...builtinDriverPlugins,
  ...builtinDecoderPlugins,
  shellPlugin,
  workbenchPlugin,
  pluginManagerPlugin,
];
