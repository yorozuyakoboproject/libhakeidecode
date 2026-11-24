import { readZip } from '../web/zip.js';
import { isDecoderComponent, isDriverComponent, normalizeRelativePath, validateManifest } from './manifest.js';
import type { ParsedPluginPackage, PluginManifest, PluginModule } from './types.js';

const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function stripCommonRoot(entries: Map<string, Uint8Array>): Record<string, Uint8Array> {
  const names = [...entries.keys()];
  if (!names.length) throw new Error('ZIP package is empty');
  const firstSlash = names[0]!.indexOf('/');
  const rootPrefix = firstSlash > 0 ? names[0]!.slice(0, firstSlash + 1) : '';
  const shouldStrip =
    !!rootPrefix && !entries.has('manifest.json') && names.every((name) => name.startsWith(rootPrefix));
  const files: Record<string, Uint8Array> = {};
  for (const [rawName, bytes] of entries) {
    const trimmed = shouldStrip ? rawName.slice(rootPrefix.length) : rawName;
    if (!trimmed || trimmed.endsWith('/')) continue;
    const normalized = normalizeRelativePath(trimmed, 'zip entry');
    if (normalized in files) throw new Error(`Duplicate ZIP entry: ${normalized}`);
    files[normalized] = bytes;
  }
  return files;
}

export async function parseZipPackage(data: ArrayBuffer | Uint8Array): Promise<ParsedPluginPackage> {
  const bytes = toUint8Array(data);
  if (bytes.byteLength > MAX_TOTAL_BYTES) throw new Error('Plugin package exceeds 32 MiB limit');
  const members = await readZip(new Blob([bytes.slice()], { type: 'application/zip' }));
  if (members.size > MAX_FILES) throw new Error('Plugin package contains too many files');
  let totalBytes = 0;
  const extracted = new Map<string, Uint8Array>();
  for (const [name, member] of members) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    totalBytes += member.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Plugin package uncompressed size exceeds 32 MiB');
    extracted.set(name, await member.read());
  }
  const files = stripCommonRoot(extracted);
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('ZIP package is missing manifest.json');
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(textDecoder.decode(manifestBytes));
  } catch {
    throw new Error('manifest.json contains invalid JSON');
  }
  const manifest = validateManifest(rawManifest);
  if (!files[manifest.entry]) throw new Error(`Missing plugin entry file: ${manifest.entry}`);
  if (manifest.workerEntry && !files[manifest.workerEntry])
    throw new Error(`Missing plugin workerEntry file: ${manifest.workerEntry}`);
  if (manifest.style && !files[manifest.style]) throw new Error(`Missing plugin style file: ${manifest.style}`);
  for (const asset of manifest.assets ?? []) {
    if (!files[asset]) throw new Error(`Missing plugin asset file: ${asset}`);
  }
  return { manifest, files };
}

export async function parseScriptPackage(
  data: ArrayBuffer | Uint8Array,
  filename = 'plugin.js',
): Promise<ParsedPluginPackage> {
  const bytes = toUint8Array(data);
  if (bytes.byteLength > MAX_TOTAL_BYTES) throw new Error('Plugin script exceeds 32 MiB limit');
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'text/javascript' }));
  let mod: PluginModule & { worker?: unknown; createWorker?: unknown; default?: unknown };
  try {
    mod = (await import(/* @vite-ignore */ url)) as typeof mod;
  } catch (error) {
    throw new Error(
      `Failed to parse plugin script (${filename}): ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
  const hasWorker = typeof mod.createWorker === 'function' || (!!mod.worker && typeof mod.worker === 'object');
  const rawManifest = (mod.manifest && typeof mod.manifest === 'object' ? { ...mod.manifest } : {}) as Record<
    string,
    unknown
  >;
  const component = mod.component;
  if (isDecoderComponent(component)) {
    const id = component.descriptor.id;
    rawManifest.kind ??= 'decoder';
    rawManifest.id ??= `decoder.${id}`;
    rawManifest.name ??= component.descriptor.name ?? id;
    rawManifest.version ??= '1.0.0';
    rawManifest.description ??= component.descriptor.desc ?? component.ui.description;
    rawManifest.entry ??= 'index.js';
    if (hasWorker) rawManifest.workerEntry ??= 'index.js';
    rawManifest.inject ??= ['componentRegistry'];
    rawManifest.order ??= 45;
  } else if (isDriverComponent(component)) {
    const id = component.descriptor.id;
    rawManifest.kind ??= 'driver';
    rawManifest.id ??= `driver.${id}`;
    rawManifest.name ??= component.descriptor.name ?? id;
    rawManifest.version ??= '1.0.0';
    rawManifest.entry ??= 'index.js';
    if (hasWorker) rawManifest.workerEntry ??= 'index.js';
    rawManifest.inject ??= ['componentRegistry'];
    rawManifest.order ??= 35;
  } else {
    if (typeof mod.setup !== 'function')
      throw new Error('Single-file plugin must export component (+ createWorker/worker) or setup(ctx)');
    rawManifest.entry ??= 'index.js';
    rawManifest.version ??= '1.0.0';
    rawManifest.kind ??= 'ui';
    if (hasWorker) rawManifest.workerEntry ??= 'index.js';
  }
  const manifest: PluginManifest = validateManifest(rawManifest);
  if ((manifest.kind === 'decoder' || manifest.kind === 'driver') && !manifest.workerEntry)
    throw new Error(`Custom ${manifest.kind} plugin must export createWorker(sdk) or worker`);
  return {
    manifest,
    files: { [manifest.entry]: bytes.slice() },
  };
}

function validateRemoteUrl(input: string): URL {
  const url = new URL(input.trim());
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('Plugin URL must use HTTPS (or HTTP on localhost)');
  return url;
}

export async function parseUrlPackage(input: string): Promise<ParsedPluginPackage> {
  const url = validateRemoteUrl(input);
  const response = await fetch(url.href, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to fetch plugin URL (HTTP ${response.status})`);
  const contentType = response.headers.get('content-type') ?? '';
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.zip') || contentType.includes('application/zip')) {
    return parseZipPackage(await response.arrayBuffer());
  }
  if (path.endsWith('.js') || path.endsWith('.mjs') || contentType.includes('javascript')) {
    return parseScriptPackage(await response.arrayBuffer(), path.split('/').pop() || 'plugin.js');
  }
  const manifest = validateManifest(await response.json());
  const paths = [
    manifest.entry,
    ...(manifest.workerEntry && manifest.workerEntry !== manifest.entry ? [manifest.workerEntry] : []),
    ...(manifest.style ? [manifest.style] : []),
    ...(manifest.assets ?? []),
  ];
  const files: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  };
  let totalBytes = files['manifest.json']!.byteLength;
  for (const rel of paths) {
    const fileUrl = new URL(rel, url);
    if (fileUrl.origin !== url.origin) throw new Error(`Cross-origin plugin file is not allowed: ${rel}`);
    const fileResponse = await fetch(fileUrl.href, { cache: 'no-store' });
    if (!fileResponse.ok) throw new Error(`Failed to fetch plugin file ${rel} (HTTP ${fileResponse.status})`);
    const bytes = new Uint8Array(await fileResponse.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Plugin package exceeds 32 MiB limit');
    files[rel] = bytes;
  }
  return { manifest, files };
}
