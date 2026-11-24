import type { DecoderDefinition } from '../decoders/definition.js';
import type { DriverDefinition } from '../drivers/definition.js';
import { PackageAssetRegistry } from './assets.js';
import { collectDependents, planActivation, resolveProviders } from './graph.js';
import { isDecoderComponent, isDriverComponent, normalizeComponentDefinition } from './manifest.js';
import { parseScriptPackage, parseUrlPackage, parseZipPackage } from './package.js';
import { hideStartup, mountRecoveryUI } from './startup.js';
import { PluginPackageStore } from './store.js';
import type {
  BuiltinPluginDefinition,
  HostService,
  InstalledPackageRecord,
  ParsedPluginPackage,
  PluginContext,
  PluginInfo,
  PluginManifest,
  PluginModule,
  PluginSource,
  PluginStatus,
  ServiceBinding,
} from './types.js';

export interface ComponentRegistryHandle {
  registerDecoder(definition: DecoderDefinition): () => void;
  registerDriver(definition: DriverDefinition): () => void;
}

interface ActiveInstance {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly module: PluginModule;
  readonly ctx: PluginContext;
  readonly cleanups: Array<() => void | Promise<void>>;
  readonly providedServices: string[];
  readonly assets?: PackageAssetRegistry;
  readonly styleEl?: HTMLLinkElement;
}

interface Candidate {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly hasBuiltin: boolean;
  readonly builtin?: BuiltinPluginDefinition;
  readonly installed?: InstalledPackageRecord;
}

const HOST_SERVICE_NAME = 'host';

export class KernelRuntime {
  private readonly store = new PluginPackageStore();
  private readonly builtins = new Map<string, BuiltinPluginDefinition>();
  private readonly installed = new Map<string, InstalledPackageRecord>();
  private readonly enabledOverrides = new Map<string, boolean>();
  private preferredProviders: Record<string, string> = {};
  private readonly active = new Map<string, ActiveInstance>();
  private readonly activeOrder: string[] = [];
  private readonly services = new Map<string, { value: unknown; providerId: string }>();
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly hostServices = new Set<string>([HOST_SERVICE_NAME]);
  private readonly hostContracts: Record<string, number> = { [HOST_SERVICE_NAME]: 1 };
  private queue: Promise<void> = Promise.resolve();
  readonly recoveryMode: boolean;
  readonly host: HostService;

  constructor(recoveryMode = false) {
    this.recoveryMode = recoveryMode;
    this.host = {
      recoveryMode,
      list: () => this.listPlugins(),
      services: () => this.listServices(),
      enable: (id) => this.enqueue(() => this.setPluginEnabled(id, true)),
      disable: (id) => this.enqueue(() => this.setPluginEnabled(id, false)),
      retry: (id) => this.enqueue(() => this.retryPlugin(id)),
      installZip: (data) => this.enqueueResult(() => this.installParsed(parseZipPackage(data))),
      installScript: (data, filename) =>
        this.enqueueResult(() => this.installParsed(parseScriptPackage(data, filename))),
      installFile: (file) =>
        this.enqueueResult(async () => {
          const buffer = await file.arrayBuffer();
          const lower = file.name.toLowerCase();
          if (lower.endsWith('.zip') || file.type === 'application/zip')
            return this.installParsed(parseZipPackage(buffer));
          if (lower.endsWith('.js') || lower.endsWith('.mjs') || file.type.includes('javascript'))
            return this.installParsed(parseScriptPackage(buffer, file.name));
          throw new Error('Unsupported plugin file type. Upload a .zip package or .js/.mjs module.');
        }),
      installUrl: (url) => this.enqueueResult(() => this.installParsed(parseUrlPackage(url))),
      uninstall: (id) => this.enqueue(() => this.uninstallPlugin(id)),
      selectProvider: (service, pluginId) => this.enqueue(() => this.changeProvider(service, pluginId)),
      restoreDefaults: () => this.enqueue(() => this.resetDefaults()),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };
    this.services.set(HOST_SERVICE_NAME, { value: this.host, providerId: '__host__' });
  }

  registerBuiltins(definitions: readonly BuiltinPluginDefinition[]): void {
    for (const def of definitions) this.builtins.set(def.manifest.id, def);
  }

  getService<T = unknown>(name: string): T | undefined {
    return this.services.get(name)?.value as T | undefined;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  private enqueueResult<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }

  private candidates(): Map<string, Candidate> {
    const map = new Map<string, Candidate>();
    for (const [id, builtin] of this.builtins) {
      map.set(id, {
        id,
        manifest: builtin.manifest,
        source: 'builtin',
        hasBuiltin: true,
        builtin,
      });
    }
    for (const [id, record] of this.installed) {
      const builtin = this.builtins.get(id);
      map.set(id, {
        id,
        manifest: record.manifest,
        source: builtin ? 'override' : 'installed',
        hasBuiltin: !!builtin,
        builtin,
        installed: record,
      });
    }
    return map;
  }

  private isEnabled(id: string): boolean {
    const override = this.enabledOverrides.get(id);
    return override === undefined ? true : override;
  }

  listPlugins(): PluginInfo[] {
    const all = [...this.candidates().values()].sort(
      (a, b) => a.manifest.order - b.manifest.order || a.id.localeCompare(b.id),
    );
    return all.map((item) => {
      const enabled = this.isEnabled(item.id);
      const isActive = this.active.has(item.id);
      const error = this.errors.get(item.id) ?? null;
      const status: PluginStatus = !enabled ? 'disabled' : isActive ? 'active' : error ? 'failed' : 'pending';
      return {
        id: item.id,
        name: item.manifest.name,
        version: item.manifest.version,
        kind: item.manifest.kind,
        description: item.manifest.description ?? '',
        author: item.manifest.author ?? '',
        source: item.source,
        status,
        enabled,
        hasBuiltin: item.hasBuiltin,
        hasWorker: !!item.manifest.workerEntry || item.manifest.kind === 'decoder' || item.manifest.kind === 'driver',
        inject: item.manifest.inject,
        optional: item.manifest.optional,
        provides: item.manifest.provides,
        order: item.manifest.order,
        error,
      };
    });
  }

  listServices(): ServiceBinding[] {
    const enabledManifests = [...this.candidates().values()]
      .filter((item) => this.isEnabled(item.id))
      .map((item) => item.manifest);
    const { candidates } = resolveProviders(enabledManifests, this.preferredProviders, this.hostServices);
    return [...candidates.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([service, providers]) => ({
        service,
        activeProvider: this.services.get(service)?.providerId ?? null,
        preferredProvider: this.preferredProviders[service] ?? null,
        providers,
      }));
  }

  async start(): Promise<void> {
    const [packages, states, providers] = await Promise.all([
      this.store.listPackages(),
      this.store.listStates(),
      this.store.getProviders(),
    ]);
    for (const pkg of packages) this.installed.set(pkg.id, pkg);
    for (const state of states) this.enabledOverrides.set(state.id, state.enabled);
    this.preferredProviders = providers;

    if (this.recoveryMode) {
      mountRecoveryUI(this.host);
      this.notify();
      return;
    }

    await this.reconcileAll();
    if (!this.services.has('shell')) {
      mountRecoveryUI(this.host, 'The shell plugin did not start. Use Plugin Recovery to enable or restore it.');
    } else {
      hideStartup();
    }
    this.notify();
  }

  private async reconcileAll(): Promise<void> {
    const all = this.candidates();
    const enabledManifests = [...all.values()].filter((item) => this.isEnabled(item.id)).map((item) => item.manifest);
    const plan = planActivation(enabledManifests, this.preferredProviders, this.hostServices, this.hostContracts);

    this.errors.clear();
    for (const [id, message] of plan.errors) this.errors.set(id, message);

    for (const id of plan.order) {
      if (this.active.has(id)) continue;
      const candidate = all.get(id);
      if (!candidate) continue;
      await this.activateCandidate(candidate, plan.providers);
    }
  }

  private async activateCandidate(candidate: Candidate, providers: ReadonlyMap<string, string>): Promise<boolean> {
    const manifest = candidate.manifest;
    const injected: Record<string, unknown> = {};
    for (const service of manifest.inject) {
      const entry = this.services.get(service);
      if (!entry) {
        this.errors.set(candidate.id, `Required service unavailable: ${service}`);
        return false;
      }
      injected[service] = entry.value;
    }
    for (const service of manifest.optional) {
      const entry = this.services.get(service);
      if (entry) injected[service] = entry.value;
    }

    let assets: PackageAssetRegistry | undefined;
    let styleEl: HTMLLinkElement | undefined;
    const cleanups: Array<() => void | Promise<void>> = [];
    const ctx: PluginContext = {
      manifest,
      services: Object.freeze(injected),
      data: this.store.pluginData(candidate.id),
      assetUrl: (relativePath) => {
        if (!assets) throw new Error(`Plugin ${candidate.id} has no package assets`);
        return assets.urlFor(relativePath);
      },
      onCleanup: (fn) => {
        cleanups.push(fn);
      },
    };

    try {
      let mod: PluginModule;
      if (candidate.installed) {
        assets = new PackageAssetRegistry(candidate.installed.files);
        if (manifest.style) {
          styleEl = document.createElement('link');
          styleEl.rel = 'stylesheet';
          styleEl.href = assets.urlFor(manifest.style);
          styleEl.dataset.pluginStyle = candidate.id;
          document.head.append(styleEl);
        }
        mod = (await import(/* @vite-ignore */ assets.urlFor(manifest.entry))) as PluginModule;
      } else if (candidate.builtin) {
        mod = await candidate.builtin.load();
      } else {
        throw new Error(`Missing plugin loader for ${candidate.id}`);
      }

      let provided: Record<string, unknown> | void = undefined;
      if (typeof mod.setup === 'function') {
        provided = await mod.setup(ctx);
      } else if (manifest.kind === 'decoder' && isDecoderComponent(mod.component)) {
        const registry = injected.componentRegistry as ComponentRegistryHandle | undefined;
        if (!registry) throw new Error('Decoder plugin requires componentRegistry service');
        const normalized = normalizeComponentDefinition('decoder', mod.component);
        cleanups.push(registry.registerDecoder(normalized));
      } else if (manifest.kind === 'driver' && isDriverComponent(mod.component)) {
        const registry = injected.componentRegistry as ComponentRegistryHandle | undefined;
        if (!registry) throw new Error('Driver plugin requires componentRegistry service');
        const normalized = normalizeComponentDefinition('driver', mod.component);
        cleanups.push(registry.registerDriver(normalized));
      } else {
        throw new Error(`Plugin ${candidate.id} exports neither setup(ctx) nor a valid component`);
      }

      const providedServices: string[] = [];
      for (const service of manifest.provides) {
        if (this.hostServices.has(service)) throw new Error(`Plugin cannot override host service: ${service}`);
        const value = provided && typeof provided === 'object' ? provided[service] : undefined;
        if (value === undefined) throw new Error(`Plugin ${candidate.id} did not return service: ${service}`);
        if (providers.get(service) === candidate.id || !this.services.has(service)) {
          this.services.set(service, { value, providerId: candidate.id });
          providedServices.push(service);
        }
      }

      this.active.set(candidate.id, {
        id: candidate.id,
        manifest,
        module: mod,
        ctx,
        cleanups,
        providedServices,
        assets,
        styleEl,
      });
      this.activeOrder.push(candidate.id);
      this.errors.delete(candidate.id);
      return true;
    } catch (error) {
      for (const fn of [...cleanups].reverse()) {
        try {
          await fn();
        } catch {}
      }
      styleEl?.remove();
      assets?.revokeAll();
      this.errors.set(candidate.id, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async deactivateIds(ids: readonly string[]): Promise<void> {
    const target = new Set(ids);
    const toStop = [...this.activeOrder].reverse().filter((id) => target.has(id));
    for (const id of toStop) {
      const instance = this.active.get(id);
      if (!instance) continue;
      this.active.delete(id);
      const pos = this.activeOrder.indexOf(id);
      if (pos >= 0) this.activeOrder.splice(pos, 1);
      for (const service of instance.providedServices) {
        if (this.services.get(service)?.providerId === id) this.services.delete(service);
      }
      try {
        await instance.module.teardown?.(instance.ctx);
      } catch {}
      for (const fn of [...instance.cleanups].reverse()) {
        try {
          await fn();
        } catch {}
      }
      instance.styleEl?.remove();
      instance.assets?.revokeAll();
    }
  }

  private activeProvidersMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [service, entry] of this.services) {
      if (entry.providerId !== '__host__') map.set(service, entry.providerId);
    }
    return map;
  }

  private activeManifestsMap(): Map<string, PluginManifest> {
    const map = new Map<string, PluginManifest>();
    for (const [id, instance] of this.active) map.set(id, instance.manifest);
    return map;
  }

  private async reloadClosure(rootIds: readonly string[]): Promise<void> {
    const closure = collectDependents(rootIds, this.activeManifestsMap(), this.activeProvidersMap());
    await this.deactivateIds(closure);
    await this.reconcileAll();
  }

  private async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    if (!this.candidates().has(id)) throw new Error(`Unknown plugin: ${id}`);
    this.enabledOverrides.set(id, enabled);
    await this.store.setEnabled(id, enabled);
    if (!enabled) {
      await this.reloadClosure([id]);
    } else {
      const affected = [id];
      const manifest = this.candidates().get(id)!.manifest;
      for (const service of manifest.provides) {
        const current = this.services.get(service)?.providerId;
        if (current && current !== '__host__' && current !== id) affected.push(current);
      }
      await this.reloadClosure(affected);
    }
    this.ensureShellOrRecovery();
    this.notify();
  }

  private async retryPlugin(id: string): Promise<void> {
    if (!this.candidates().has(id)) throw new Error(`Unknown plugin: ${id}`);
    this.errors.delete(id);
    await this.reloadClosure([id]);
    this.ensureShellOrRecovery();
    this.notify();
  }

  private async installParsed(parsedPromise: Promise<ParsedPluginPackage>): Promise<PluginInfo> {
    const parsed = await parsedPromise;
    const id = parsed.manifest.id;
    const previousRecord = this.installed.get(id);
    const previousEnabled = this.enabledOverrides.get(id);
    const record: InstalledPackageRecord = {
      id,
      manifest: parsed.manifest,
      files: parsed.files,
      installedAt: Date.now(),
    };

    const affected = [id];
    for (const service of parsed.manifest.provides) {
      const current = this.services.get(service)?.providerId;
      if (current && current !== '__host__' && current !== id) affected.push(current);
    }

    this.installed.set(id, record);
    this.enabledOverrides.set(id, true);
    await this.reloadClosure(affected);

    if (!this.active.has(id)) {
      const reason = this.errors.get(id) ?? 'Plugin failed to activate';
      if (previousRecord) this.installed.set(id, previousRecord);
      else this.installed.delete(id);
      if (previousEnabled === undefined) this.enabledOverrides.delete(id);
      else this.enabledOverrides.set(id, previousEnabled);
      await this.reloadClosure(affected);
      this.notify();
      throw new Error(reason);
    }

    await this.store.putPackage(record);
    await this.store.setEnabled(id, true);
    this.ensureShellOrRecovery();
    this.notify();
    return this.listPlugins().find((item) => item.id === id)!;
  }

  private async uninstallPlugin(id: string): Promise<void> {
    if (!this.installed.has(id)) throw new Error(`Plugin is not installed: ${id}`);
    this.installed.delete(id);
    await this.store.deletePackage(id);
    if (!this.builtins.has(id)) {
      this.enabledOverrides.delete(id);
      await this.store.deleteState(id);
    }
    for (const [service, provider] of Object.entries(this.preferredProviders)) {
      if (provider === id && !this.builtins.has(id)) delete this.preferredProviders[service];
    }
    await this.store.setProviders(this.preferredProviders);
    await this.reloadClosure([id]);
    this.ensureShellOrRecovery();
    this.notify();
  }

  private async changeProvider(service: string, pluginId: string | null): Promise<void> {
    const previous = this.services.get(service)?.providerId;
    if (pluginId) this.preferredProviders[service] = pluginId;
    else delete this.preferredProviders[service];
    await this.store.setProviders(this.preferredProviders);
    const roots = [previous, pluginId].filter((value): value is string => !!value && value !== '__host__');
    await this.reloadClosure(roots);
    this.ensureShellOrRecovery();
    this.notify();
  }

  private async resetDefaults(): Promise<void> {
    const allActive = [...this.activeOrder];
    await this.deactivateIds(allActive);
    this.enabledOverrides.clear();
    this.preferredProviders = {};
    await this.store.clearStates();
    await this.store.setProviders({});
    if (!this.recoveryMode) await this.reconcileAll();
    this.ensureShellOrRecovery();
    this.notify();
  }

  private ensureShellOrRecovery(): void {
    if (this.recoveryMode) return;
    if (!this.services.has('shell')) {
      mountRecoveryUI(this.host, 'The shell plugin is disabled or failed. Enable or restore it below.');
    }
  }
}
