import {
  clearDecoderDefinitions,
  decoderDefinitions,
  registerDecoderDefinition,
  unregisterDecoderDefinition,
  type DecoderDefinition,
} from '../decoders/index.js';
import {
  clearDriverDefinitions,
  driverDefinitions,
  registerDriverDefinition,
  unregisterDriverDefinition,
  type DriverDefinition,
} from '../drivers/index.js';
import type { BuiltinPluginDefinition, PluginContext } from '../kernel/types.js';
import { registerComponentMessages } from '../web/i18n.js';

export interface ComponentRegistryService {
  readonly decoders: readonly DecoderDefinition[];
  readonly drivers: readonly DriverDefinition[];
  registerDecoder(definition: DecoderDefinition): () => void;
  registerDriver(definition: DriverDefinition): () => void;
  subscribe(listener: () => void): () => void;
}

export const registryPlugin: BuiltinPluginDefinition = {
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'hakei.registry',
    name: 'Component Registry',
    version: '1.0.0',
    kind: 'core',
    entry: 'registry.js',
    inject: [],
    optional: [],
    provides: ['componentRegistry'],
    contracts: { componentRegistry: 1 },
    order: 10,
    description: 'Reactive registry for protocol decoder and capture driver plugins.',
  },
  load: () => ({
    setup(ctx: PluginContext) {
      clearDecoderDefinitions();
      clearDriverDefinitions();

      const listeners = new Set<() => void>();
      let scheduled = false;
      const emit = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          for (const listener of listeners) {
            try {
              listener();
            } catch {}
          }
        });
      };

      const registry: ComponentRegistryService = {
        get decoders() {
          return decoderDefinitions;
        },
        get drivers() {
          return driverDefinitions;
        },
        registerDecoder(definition: DecoderDefinition) {
          registerDecoderDefinition(definition);
          registerComponentMessages(definition.messages);
          emit();
          return () => {
            unregisterDecoderDefinition(definition.descriptor.id);
            emit();
          };
        },
        registerDriver(definition: DriverDefinition) {
          registerDriverDefinition(definition);
          registerComponentMessages(definition.messages);
          emit();
          return () => {
            unregisterDriverDefinition(definition.descriptor.id);
            emit();
          };
        },
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      ctx.onCleanup(() => {
        listeners.clear();
        clearDecoderDefinitions();
        clearDriverDefinitions();
      });

      return { componentRegistry: registry };
    },
  }),
};
