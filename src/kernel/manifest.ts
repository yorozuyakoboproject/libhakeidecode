import type { DecoderDefinition } from '../decoders/definition.js';
import type { DriverDefinition } from '../drivers/definition.js';
import type { PluginKind, PluginManifest } from './types.js';

export const KERNEL_SCHEMA_VERSION = 1 as const;
export const KERNEL_API_VERSION = 1 as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SERVICE_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
const KINDS = new Set<PluginKind>(['core', 'ui', 'decoder', 'driver']);

export function normalizeRelativePath(input: unknown, field: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`Invalid manifest ${field}`);
  const cleaned = input.replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!cleaned || cleaned.startsWith('/') || cleaned.endsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned))
    throw new Error(`Unsafe manifest path in ${field}: ${input}`);
  const segments = cleaned.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('\0')))
    throw new Error(`Unsafe manifest path in ${field}: ${input}`);
  return segments.join('/');
}

function stringList(input: unknown, field: string, pattern: RegExp): readonly string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error(`Manifest ${field} must be an array`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || !pattern.test(item))
      throw new Error(`Invalid entry in manifest ${field}: ${String(item)}`);
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function validateManifest(raw: unknown): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Plugin manifest must be a JSON object');
  const data = raw as Record<string, unknown>;
  const schemaVersion = data.schemaVersion ?? KERNEL_SCHEMA_VERSION;
  const apiVersion = data.apiVersion ?? KERNEL_API_VERSION;
  if (schemaVersion !== KERNEL_SCHEMA_VERSION)
    throw new Error(`Unsupported plugin schemaVersion: ${String(schemaVersion)}`);
  if (apiVersion !== KERNEL_API_VERSION) throw new Error(`Unsupported plugin apiVersion: ${String(apiVersion)}`);
  if (typeof data.id !== 'string' || !ID_PATTERN.test(data.id))
    throw new Error(`Invalid plugin id: ${String(data.id)}`);
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 100)
    throw new Error(`Invalid plugin name: ${String(data.name)}`);
  if (typeof data.version !== 'string' || !data.version.trim() || data.version.trim().length > 40)
    throw new Error(`Invalid plugin version: ${String(data.version)}`);
  if (typeof data.kind !== 'string' || !KINDS.has(data.kind as PluginKind))
    throw new Error(`Invalid plugin kind: ${String(data.kind)}`);
  const entry = normalizeRelativePath(data.entry, 'entry');
  const workerEntry =
    data.workerEntry === undefined ? undefined : normalizeRelativePath(data.workerEntry, 'workerEntry');
  const style = data.style === undefined ? undefined : normalizeRelativePath(data.style, 'style');
  const assets =
    data.assets === undefined
      ? undefined
      : Array.isArray(data.assets)
        ? data.assets.map((item, idx) => normalizeRelativePath(item, `assets[${idx}]`))
        : (() => {
            throw new Error('Manifest assets must be an array');
          })();
  const inject = stringList(data.inject, 'inject', SERVICE_PATTERN);
  const optional = stringList(data.optional, 'optional', SERVICE_PATTERN);
  const provides = stringList(data.provides, 'provides', SERVICE_PATTERN);
  const contracts: Record<string, number> = {};
  if (data.contracts !== undefined) {
    if (!data.contracts || typeof data.contracts !== 'object' || Array.isArray(data.contracts))
      throw new Error('Manifest contracts must be an object');
    for (const [service, version] of Object.entries(data.contracts as Record<string, unknown>)) {
      if (!SERVICE_PATTERN.test(service) || typeof version !== 'number' || !Number.isInteger(version) || version < 1)
        throw new Error(`Invalid contract for ${service}`);
      contracts[service] = version;
    }
  }
  const order = data.order === undefined ? 500 : Number(data.order);
  if (!Number.isFinite(order)) throw new Error('Manifest order must be a finite number');
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, 300) : undefined;
  const author = typeof data.author === 'string' ? data.author.trim().slice(0, 80) : undefined;
  return deepFreeze({
    schemaVersion: 1,
    apiVersion: 1,
    id: data.id,
    name: data.name.trim(),
    version: data.version.trim(),
    kind: data.kind as PluginKind,
    entry,
    ...(workerEntry ? { workerEntry } : {}),
    ...(style ? { style } : {}),
    ...(assets?.length ? { assets } : {}),
    inject,
    optional,
    provides,
    contracts,
    order,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
  });
}

export function isDecoderComponent(value: unknown): value is DecoderDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DecoderDefinition>;
  return (
    !!candidate.descriptor &&
    typeof candidate.descriptor.id === 'string' &&
    !!candidate.ui &&
    Array.isArray(candidate.ui.inputs) &&
    Array.isArray(candidate.ui.rows)
  );
}

export function isDriverComponent(value: unknown): value is DriverDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DriverDefinition>;
  return (
    !!candidate.descriptor &&
    typeof candidate.descriptor.id === 'string' &&
    !!candidate.descriptor.capabilities &&
    !('ui' in candidate && candidate.ui)
  );
}

export function normalizeComponentDefinition<T extends DecoderDefinition | DriverDefinition>(
  kind: 'decoder' | 'driver',
  raw: T,
): T {
  const id = raw.descriptor.id;
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(id)) throw new Error(`Invalid ${kind} component id: ${id}`);
  const fallbackName = raw.descriptor.name ?? id;
  const key = `${kind}.${id}.name`;
  const en = { [key]: fallbackName, ...(raw.messages?.en ?? {}) };
  const zh = raw.messages?.['zh-CN'] ? { ...raw.messages['zh-CN'] } : undefined;
  return {
    ...raw,
    messages: zh ? { en, 'zh-CN': zh } : { en },
  };
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
