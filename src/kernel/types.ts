import type { DecoderDefinition } from '../decoders/definition.js';
import type { DriverDefinition } from '../drivers/definition.js';

export type PluginKind = 'core' | 'ui' | 'decoder' | 'driver';
export type PluginSource = 'builtin' | 'installed' | 'override';
export type PluginStatus = 'active' | 'disabled' | 'failed' | 'pending';

export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly apiVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly entry: string;
  readonly workerEntry?: string;
  readonly style?: string;
  readonly assets?: readonly string[];
  readonly inject: readonly string[];
  readonly optional: readonly string[];
  readonly provides: readonly string[];
  readonly contracts: Readonly<Record<string, number>>;
  readonly order: number;
  readonly description?: string;
  readonly author?: string;
}

export interface PluginDataStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly services: Readonly<Record<string, unknown>>;
  readonly data: PluginDataStore;
  assetUrl(relativePath: string): string;
  onCleanup(fn: () => void | Promise<void>): void;
}

export interface PluginModule {
  setup?(ctx: PluginContext): Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
  teardown?(ctx: PluginContext): void | Promise<void>;
  component?: DecoderDefinition | DriverDefinition;
  manifest?: Partial<PluginManifest>;
}

export interface BuiltinPluginDefinition {
  readonly manifest: PluginManifest;
  readonly load: () => Promise<PluginModule> | PluginModule;
}

export interface InstalledPackageRecord {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly installedAt: number;
}

export interface PluginStateRecord {
  readonly id: string;
  readonly enabled: boolean;
}

export interface PluginInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly description: string;
  readonly author: string;
  readonly source: PluginSource;
  readonly status: PluginStatus;
  readonly enabled: boolean;
  readonly hasBuiltin: boolean;
  readonly hasWorker: boolean;
  readonly inject: readonly string[];
  readonly optional: readonly string[];
  readonly provides: readonly string[];
  readonly order: number;
  readonly error: string | null;
}

export interface ServiceBinding {
  readonly service: string;
  readonly activeProvider: string | null;
  readonly preferredProvider: string | null;
  readonly providers: readonly string[];
}

export interface ParsedPluginPackage {
  readonly manifest: PluginManifest;
  readonly files: Readonly<Record<string, Uint8Array>>;
}

export interface HostService {
  readonly recoveryMode: boolean;
  list(): PluginInfo[];
  services(): ServiceBinding[];
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  installZip(data: ArrayBuffer | Uint8Array): Promise<PluginInfo>;
  installScript(data: ArrayBuffer | Uint8Array, filename?: string): Promise<PluginInfo>;
  installFile(file: File): Promise<PluginInfo>;
  installUrl(url: string): Promise<PluginInfo>;
  uninstall(id: string): Promise<void>;
  selectProvider(service: string, pluginId: string | null): Promise<void>;
  restoreDefaults(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
