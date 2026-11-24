const textDecoder = new TextDecoder('utf-8');

function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function isScriptPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.js') || lower.endsWith('.mjs');
}

function resolvePackagePath(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const baseParts = fromFile.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!baseParts.length) return null;
      baseParts.pop();
    } else baseParts.push(segment);
  }
  return baseParts.join('/');
}

function extractRelativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const staticRe = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?(['"])(\.\.?\/[^'"]+)\1/g;
  const dynamicRe = /\bimport\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;
  for (const match of source.matchAll(staticRe)) specs.push(match[2]!);
  for (const match of source.matchAll(dynamicRe)) specs.push(match[2]!);
  return specs;
}

function rewriteSpecifiers(source: string, map: ReadonlyMap<string, string>): string {
  if (!map.size) return source;
  const replace = (spec: string): string => map.get(spec) ?? spec;
  return source
    .replace(
      /(\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?)(['"])(\.\.?\/[^'"]+)\2/g,
      (_full, prefix: string, quote: string, spec: string) => `${prefix}${quote}${replace(spec)}${quote}`,
    )
    .replace(
      /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2(\s*\))/g,
      (_full, prefix: string, quote: string, spec: string, suffix: string) =>
        `${prefix}${quote}${replace(spec)}${quote}${suffix}`,
    );
}

export class PackageAssetRegistry {
  private readonly urls = new Map<string, string>();
  private readonly visiting = new Set<string>();

  constructor(private readonly files: Readonly<Record<string, Uint8Array>>) {}

  urlFor(relativePath: string): string {
    const clean = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
    const existing = this.urls.get(clean);
    if (existing) return existing;
    const bytes = this.files[clean];
    if (!bytes) throw new Error(`Package asset not found: ${clean}`);
    if (isScriptPath(clean)) return this.buildModuleUrl(clean, bytes);
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mimeTypeFor(clean) }));
    this.urls.set(clean, url);
    return url;
  }

  private buildModuleUrl(path: string, bytes: Uint8Array): string {
    if (this.visiting.has(path)) throw new Error(`Cyclic relative import in plugin package: ${path}`);
    this.visiting.add(path);
    try {
      const source = textDecoder.decode(bytes);
      const replacements = new Map<string, string>();
      for (const spec of extractRelativeSpecifiers(source)) {
        const target = resolvePackagePath(path, spec);
        if (target && this.files[target]) replacements.set(spec, this.urlFor(target));
      }
      const rewritten = rewriteSpecifiers(source, replacements);
      const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
      this.urls.set(path, url);
      return url;
    } finally {
      this.visiting.delete(path);
    }
  }

  revokeAll(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
