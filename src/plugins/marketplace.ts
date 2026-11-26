import { KERNEL_API_VERSION, KERNEL_SCHEMA_VERSION } from '../kernel/manifest.js';
import type { HostService, PluginDataStore, PluginInfo, PluginKind } from '../kernel/types.js';
import { getLocale, t, type Locale } from '../web/i18n.js';

export type LocalizedText = string | Readonly<Record<string, string>>;
export type RegistryTier = 'official' | 'community' | 'custom';

export interface RegistrySource {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly builtin?: boolean;
}

export interface RegistryPluginEntry {
  readonly id: string;
  readonly slug: string;
  readonly tier: RegistryTier;
  readonly host: string;
  readonly kind: PluginKind;
  readonly version: string;
  readonly apiVersion: number;
  readonly manifestSchemaVersion: number;
  readonly name: LocalizedText;
  readonly summary: LocalizedText;
  readonly tags: readonly string[];
  readonly author: string;
  readonly homepage?: string;
  readonly license?: string;
  readonly packageUrl?: string;
  readonly manifestUrl?: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
}

export interface SourceFetchResult {
  readonly source: RegistrySource;
  readonly entries: readonly RegistryPluginEntry[];
  readonly generatedAt?: string;
  readonly error?: string;
}

const SOURCES_STORAGE_KEY = 'marketplace.sources.v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const VALID_KINDS = new Set<PluginKind>(['core', 'ui', 'decoder', 'driver']);
const FETCH_TIMEOUT_MS = 20_000;

export const DEFAULT_OFFICIAL_REGISTRY_URL =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_PLUGIN_REGISTRY_URL?.trim() ||
  'https://xizeyoupan.github.io/plugins/hakeidecode/registry.json';

export function defaultRegistrySources(): RegistrySource[] {
  return [
    {
      id: 'official',
      label: t('plugins.market.defaultSource'),
      url: DEFAULT_OFFICIAL_REGISTRY_URL,
      enabled: true,
      builtin: true,
    },
  ];
}

export function validateRegistryUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(t('plugins.market.invalidUrl'));
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error(t('plugins.market.httpsRequired'));
  }
  if (parsed.username || parsed.password) {
    throw new Error(t('plugins.market.invalidUrl'));
  }
  parsed.hash = '';
  return parsed.href;
}

function safeExternalLink(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  try {
    const parsed = new URL(input.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function resolvePackageLink(input: unknown, baseUrl: string): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  try {
    const resolved = new URL(input.trim(), baseUrl);
    return validateRegistryUrl(resolved.href);
  } catch {
    return undefined;
  }
}

export async function loadRegistrySources(data: PluginDataStore): Promise<RegistrySource[]> {
  const defaults = defaultRegistrySources();
  const saved = await data.get<unknown>(SOURCES_STORAGE_KEY);
  if (!Array.isArray(saved)) return defaults;

  const normalized: RegistrySource[] = [];
  const seenUrls = new Set<string>();
  for (const item of saved) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<RegistrySource>;
    if (typeof raw.url !== 'string' || typeof raw.id !== 'string') continue;
    try {
      const url = validateRegistryUrl(raw.url);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const builtin = raw.id === 'official' || Boolean(raw.builtin);
      normalized.push({
        id: raw.id,
        label:
          typeof raw.label === 'string' && raw.label.trim()
            ? raw.label.trim()
            : builtin
              ? t('plugins.market.defaultSource')
              : new URL(url).host,
        url,
        enabled: raw.enabled !== false,
        ...(builtin ? { builtin: true } : {}),
      });
    } catch {}
  }

  for (const def of defaults) {
    if (!normalized.some((item) => item.id === def.id || item.url === def.url)) {
      normalized.unshift(def);
    }
  }
  return normalized;
}

export async function saveRegistrySources(data: PluginDataStore, sources: readonly RegistrySource[]): Promise<void> {
  await data.set(
    SOURCES_STORAGE_KEY,
    sources.map((item) => ({
      id: item.id,
      label: item.label,
      url: item.url,
      enabled: item.enabled,
      ...(item.builtin ? { builtin: true } : {}),
    })),
  );
}

export function resolveLocalizedText(
  value: LocalizedText | undefined,
  locale: Locale = getLocale(),
  fallback = '',
): string {
  if (typeof value === 'string') return value.trim() || fallback;
  if (!value || typeof value !== 'object') return fallback;
  const preferred =
    locale === 'zh-CN' ? (value['zh-CN'] ?? value.zh ?? value.en) : (value.en ?? value['zh-CN'] ?? value.zh);
  if (typeof preferred === 'string' && preferred.trim()) return preferred.trim();
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function parseVersionParts(version: string): { core: number[]; pre: string[] } {
  const noBuild = version.trim().replace(/^v/i, '').split('+', 1)[0] ?? '';
  const dash = noBuild.indexOf('-');
  const coreStr = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
  const preStr = dash >= 0 ? noBuild.slice(dash + 1) : '';
  const core = coreStr.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const pre = preStr ? preStr.split('.') : [];
  return { core, pre };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  const len = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < len; i++) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const preLen = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < preLen; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = /^\d+$/.test(l) ? Number(l) : null;
    const rNum = /^\d+$/.test(r) ? Number(r) : null;
    if (lNum !== null && rNum !== null) return lNum > rNum ? 1 : -1;
    if (lNum !== null) return -1;
    if (rNum !== null) return 1;
    return l.localeCompare(r);
  }
  return 0;
}

async function fetchWithTimeout(url: string, accept: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: accept },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchRegistrySource(source: RegistrySource, signal?: AbortSignal): Promise<SourceFetchResult> {
  try {
    const url = validateRegistryUrl(source.url);
    const response = await fetchWithTimeout(url, 'application/json, */*', signal);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = (await response.json()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(t('plugins.market.invalidRegistry'));
    }
    const doc = raw as Record<string, unknown>;
    if (typeof doc.host === 'string' && doc.host !== 'hakeidecode') {
      throw new Error(t('plugins.market.wrongHost', { host: doc.host }));
    }
    if (!Array.isArray(doc.plugins)) {
      throw new Error(t('plugins.market.invalidRegistry'));
    }

    const entries: RegistryPluginEntry[] = [];
    for (const item of doc.plugins) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.id !== 'string' || !rec.id.trim()) continue;
      if (typeof rec.version !== 'string' || !rec.version.trim()) continue;
      if (typeof rec.kind !== 'string' || !VALID_KINDS.has(rec.kind as PluginKind)) continue;
      if (typeof rec.host === 'string' && rec.host !== 'hakeidecode') continue;

      const apiVersion = typeof rec.apiVersion === 'number' ? rec.apiVersion : KERNEL_API_VERSION;
      const manifestSchemaVersion =
        typeof rec.manifestSchemaVersion === 'number' ? rec.manifestSchemaVersion : KERNEL_SCHEMA_VERSION;
      if (apiVersion !== KERNEL_API_VERSION || manifestSchemaVersion !== KERNEL_SCHEMA_VERSION) continue;

      const packageUrl = resolvePackageLink(rec.packageUrl, url);
      const manifestUrl = resolvePackageLink(rec.manifestUrl, url);
      if (!packageUrl && !manifestUrl) continue;

      const tier: RegistryTier = source.builtin ? (rec.tier === 'official' ? 'official' : 'community') : 'custom';
      const sha256 =
        typeof rec.sha256 === 'string' && SHA256_PATTERN.test(rec.sha256.trim())
          ? rec.sha256.trim().toLowerCase()
          : undefined;
      const tags = Array.isArray(rec.tags)
        ? rec.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).map((tag) => tag.trim())
        : [];

      entries.push({
        id: rec.id.trim(),
        slug: typeof rec.slug === 'string' && rec.slug.trim() ? rec.slug.trim() : rec.id.trim(),
        tier,
        host: 'hakeidecode',
        kind: rec.kind as PluginKind,
        version: rec.version.trim(),
        apiVersion,
        manifestSchemaVersion,
        name:
          typeof rec.name === 'string' || (rec.name && typeof rec.name === 'object')
            ? (rec.name as LocalizedText)
            : rec.id.trim(),
        summary:
          typeof rec.summary === 'string' || (rec.summary && typeof rec.summary === 'object')
            ? (rec.summary as LocalizedText)
            : '',
        tags,
        author: typeof rec.author === 'string' && rec.author.trim() ? rec.author.trim() : '',
        homepage: safeExternalLink(rec.homepage),
        license: typeof rec.license === 'string' && rec.license.trim() ? rec.license.trim() : undefined,
        packageUrl,
        manifestUrl,
        size: typeof rec.size === 'number' && Number.isFinite(rec.size) ? rec.size : undefined,
        sha256,
        sourceId: source.id,
        sourceLabel: source.label,
      });
    }

    return {
      source,
      entries,
      generatedAt: typeof doc.generatedAt === 'string' ? doc.generatedAt : undefined,
    };
  } catch (error) {
    return {
      source,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isZipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

async function verifySha256(bytes: Uint8Array, expectedHex: string): Promise<void> {
  if (!globalThis.crypto?.subtle) return;
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (actual !== expectedHex.toLowerCase()) {
    throw new Error(
      t('plugins.market.shaMismatch', {
        expected: expectedHex.slice(0, 12),
        actual: actual.slice(0, 12),
      }),
    );
  }
}

export async function installMarketplacePlugin(host: HostService, entry: RegistryPluginEntry): Promise<PluginInfo> {
  const targetUrl = entry.packageUrl ?? entry.manifestUrl;
  if (!targetUrl) {
    throw new Error(t('plugins.market.missingUrl'));
  }
  const validated = validateRegistryUrl(targetUrl);

  if (entry.packageUrl || /\.(?:zip|mjs|js)(?:$|\?)/i.test(validated)) {
    const response = await fetchWithTimeout(validated, 'application/zip, text/javascript, */*');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (entry.sha256) {
      await verifySha256(bytes, entry.sha256);
    }
    const pathname = new URL(validated).pathname.toLowerCase();
    if (isZipBytes(bytes) || pathname.endsWith('.zip')) {
      return host.installZip(bytes);
    }
    if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) {
      return host.installScript(bytes, pathname.split('/').pop() || `${entry.slug}.js`);
    }
  }

  return host.installUrl(entry.manifestUrl ?? validated);
}
