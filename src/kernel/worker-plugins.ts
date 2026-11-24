import { ComponentError } from '../components.js';
import { BinaryStore } from '../decoders/binary-store.js';
import { resultMemory, type DecoderWorkerDefinition } from '../decoders/definition.js';
import { EventRuntime } from '../decoders/event-runtime.js';
import { createStandardWorker } from '../decoders/standard-worker.js';
import { registerDecoderWorker, unregisterDecoderWorker } from '../decoders/workers.js';
import type { DriverWorkerDefinition } from '../drivers/definition.js';
import { registerDriverWorker, unregisterDriverWorker } from '../drivers/workers.js';
import {
  defaultDeviceConfiguration,
  deviceChannelIndices,
  packedLogicSampleBytes,
  resolveDeviceConfiguration,
  validateDeviceConfiguration,
} from '../libhakei/device.js';
import { createSampleChunk } from '../libhakei/index.js';
import { compareSamples, maxSample, minSample, sampleIndex, sampleRatio } from '../libhakei/sample-index.js';
import {
  Decoder,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_LOGIC,
  OUTPUT_META,
  OUTPUT_PYTHON,
  SRD_CONF_SAMPLERATE,
  createEdgeWindow,
  createEdgesWindow,
  createPackedWindow,
  createSignalWindow,
  createValuesWindow,
} from '../libhakeidecode/index.js';
import { PackageAssetRegistry } from './assets.js';
import { PluginPackageStore } from './store.js';
import type { InstalledPackageRecord, PluginKind } from './types.js';

export const workerPluginSdk = Object.freeze({
  Decoder,
  EventRuntime,
  BinaryStore,
  resultMemory,
  createStandardWorker,
  OUTPUT_ANN,
  OUTPUT_BINARY,
  OUTPUT_LOGIC,
  OUTPUT_META,
  OUTPUT_PYTHON,
  SRD_CONF_SAMPLERATE,
  createSignalWindow,
  createValuesWindow,
  createPackedWindow,
  createEdgeWindow,
  createEdgesWindow,
  ComponentError,
  sampleRatio,
  sampleIndex,
  compareSamples,
  minSample,
  maxSample,
  validateDeviceConfiguration,
  resolveDeviceConfiguration,
  defaultDeviceConfiguration,
  deviceChannelIndices,
  packedLogicSampleBytes,
  createSampleChunk,
});

export type WorkerPluginSdk = typeof workerPluginSdk;

interface LoadedWorkerPlugin {
  readonly packageId: string;
  readonly kind: 'decoder' | 'driver';
  readonly componentId: string;
  readonly installedAt: number;
  readonly assets: PackageAssetRegistry;
}

const store = new PluginPackageStore();
const loadedByPackage = new Map<string, LoadedWorkerPlugin>();

function isValidDecoderWorker(value: unknown): value is DecoderWorkerDefinition {
  if (!value || typeof value !== 'object') return false;
  const worker = value as Partial<DecoderWorkerDefinition>;
  return (
    typeof worker.id === 'string' &&
    !!worker.id &&
    typeof worker.createRuntime === 'function' &&
    typeof worker.csvHeader === 'string' &&
    typeof worker.csvRow === 'function'
  );
}

function isValidDriverWorker(value: unknown): value is DriverWorkerDefinition {
  if (!value || typeof value !== 'object') return false;
  const worker = value as Partial<DriverWorkerDefinition>;
  return typeof worker.id === 'string' && !!worker.id && typeof worker.createDevice === 'function';
}

function unloadPackage(packageId: string): void {
  const existing = loadedByPackage.get(packageId);
  if (!existing) return;
  loadedByPackage.delete(packageId);
  if (existing.kind === 'decoder') unregisterDecoderWorker(existing.componentId);
  else unregisterDriverWorker(existing.componentId);
  existing.assets.revokeAll();
}

async function loadWorkerPackage(pkg: InstalledPackageRecord): Promise<LoadedWorkerPlugin | null> {
  const kind = pkg.manifest.kind;
  if ((kind !== 'decoder' && kind !== 'driver') || !pkg.manifest.workerEntry) return null;
  const existing = loadedByPackage.get(pkg.id);
  if (existing && existing.installedAt === pkg.installedAt) return existing;
  unloadPackage(pkg.id);

  const assets = new PackageAssetRegistry(pkg.files);
  try {
    const mod = (await import(/* @vite-ignore */ assets.urlFor(pkg.manifest.workerEntry))) as {
      createWorker?: (sdk: WorkerPluginSdk) => unknown | Promise<unknown>;
      worker?: unknown;
      default?: unknown;
    };
    const rawWorker =
      typeof mod.createWorker === 'function' ? await mod.createWorker(workerPluginSdk) : (mod.worker ?? mod.default);
    if (kind === 'decoder') {
      if (!isValidDecoderWorker(rawWorker)) throw new Error(`Invalid decoder worker exported by plugin ${pkg.id}`);
      registerDecoderWorker(rawWorker);
      const entry: LoadedWorkerPlugin = {
        packageId: pkg.id,
        kind,
        componentId: rawWorker.id,
        installedAt: pkg.installedAt,
        assets,
      };
      loadedByPackage.set(pkg.id, entry);
      return entry;
    }
    if (!isValidDriverWorker(rawWorker)) throw new Error(`Invalid driver worker exported by plugin ${pkg.id}`);
    registerDriverWorker(rawWorker);
    const entry: LoadedWorkerPlugin = {
      packageId: pkg.id,
      kind,
      componentId: rawWorker.id,
      installedAt: pkg.installedAt,
      assets,
    };
    loadedByPackage.set(pkg.id, entry);
    return entry;
  } catch (error) {
    assets.revokeAll();
    throw error;
  }
}

async function syncKind(kind: Extract<PluginKind, 'decoder' | 'driver'>, targetId: string): Promise<void> {
  const [packages, states] = await Promise.all([store.listPackages(), store.listStates()]);
  const enabledMap = new Map(states.map((item) => [item.id, item.enabled]));
  const isEnabled = (id: string): boolean => enabledMap.get(id) !== false;
  const presentIds = new Set(packages.map((pkg) => pkg.id));

  for (const [pkgId, loaded] of [...loadedByPackage]) {
    if (loaded.kind !== kind) continue;
    if (!presentIds.has(pkgId) || !isEnabled(pkgId)) unloadPackage(pkgId);
  }

  const kindPackages = packages.filter((pkg) => pkg.manifest.kind === kind && pkg.manifest.workerEntry);
  const direct = kindPackages.find((pkg) => pkg.id === `${kind}.${targetId}`);
  if (direct) {
    if (!isEnabled(direct.id)) throw new Error(`Plugin is disabled: ${direct.id}`);
    await loadWorkerPackage(direct);
    return;
  }

  for (const pkg of kindPackages) {
    if (!isEnabled(pkg.id)) continue;
    const loaded = await loadWorkerPackage(pkg);
    if (loaded?.componentId === targetId) return;
  }

  if (!isEnabled(`${kind}.${targetId}`)) throw new Error(`Plugin is disabled: ${kind}.${targetId}`);
}

export function ensureWorkerDecoder(id: string): Promise<void> {
  return syncKind('decoder', id);
}

export function ensureWorkerDriver(id: string): Promise<void> {
  return syncKind('driver', id);
}
