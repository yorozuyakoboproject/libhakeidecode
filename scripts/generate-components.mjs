import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

const root = fileURLToPath(new URL('../', import.meta.url));
const groups = [
  {
    directory: 'decoders',
    kind: 'decoder',
    definition: 'DecoderDefinition',
    workerDefinition: 'DecoderWorkerDefinition',
  },
  { directory: 'drivers', kind: 'driver', definition: 'DriverDefinition', workerDefinition: 'DriverWorkerDefinition' },
];

async function writeGenerated(path, source) {
  if ((await readFile(path, 'utf8').catch(() => '')) === source) return;
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, source);
  await rename(temporary, path);
}

async function inspectUiGraph(path, visited) {
  if (visited.has(path)) return;
  visited.add(path);
  const local = relative(root, path).replaceAll('\\', '/');
  if (
    local.startsWith('src/web/') ||
    (local.startsWith('src/libhakeidecode/') && local !== 'src/libhakeidecode/types.ts')
  )
    throw new Error('Component UI depends on application or decode infrastructure: ' + local);
  if (
    /(?:^|\/)(?:runtime|worker|transport|engine)\.ts$/.test(local) ||
    /src\/(?:decoders|drivers)\/[^/]+\/index\.ts$/.test(local) ||
    /-worker\.ts$/.test(local)
  )
    throw new Error('UI component imports Worker implementation: ' + local);
  const scanner = createScanner(true, undefined, await readFile(path, 'utf8'));
  const tokens = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan())
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  const dependencies = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index],
      next = tokens[index + 1];
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) continue;
    if (next?.text === 'type') continue;
    if (token.kind === SyntaxKind.ImportKeyword && next?.kind === SyntaxKind.OpenParenToken)
      throw new Error('UI components must use explicit imports: ' + local);
    if (token.kind === SyntaxKind.ImportKeyword && next?.kind === SyntaxKind.DotToken) continue;
    if (
      token.kind === SyntaxKind.ExportKeyword &&
      ![SyntaxKind.OpenBraceToken, SyntaxKind.AsteriskToken].includes(next?.kind)
    )
      continue;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      if (tokens[cursor].kind === SyntaxKind.SemicolonToken) break;
      if (tokens[cursor].kind === SyntaxKind.StringLiteral) {
        dependencies.push(tokens[cursor].value);
        break;
      }
    }
  }
  for (const dependency of dependencies) {
    if (!dependency.startsWith('.') || !dependency.endsWith('.js'))
      throw new Error('UI component dependency must be a local ESM module: ' + local);
    const target = resolve(dirname(path), dependency.replace(/\.js$/, '.ts'));
    if (relative(root, target).startsWith('..'))
      throw new Error('Component dependency is outside the project: ' + local);
    await inspectUiGraph(target, visited);
  }
}

export async function generateComponents() {
  const output = resolve(root, 'src/generated');
  await mkdir(output, { recursive: true });
  const discovered = [];
  const exports = [];
  const encoders = [];
  for (const group of groups) {
    const entries = await readdir(resolve(root, 'src', group.directory), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (!names.length) throw new Error('No components found in src/' + group.directory);
    if (entries.some((entry) => entry.isSymbolicLink()))
      throw new Error('Component directories cannot be symbolic links');
    for (const name of names) {
      if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(name)) throw new Error('Invalid component directory: ' + name);
      for (const entry of ['component.ts', 'worker.ts', 'index.ts']) {
        const path = resolve(root, 'src', group.directory, name, entry);
        if (!(await stat(path).catch(() => null))?.isFile())
          throw new Error('Missing component entry: ' + relative(root, path));
      }
      if (group.directory === 'decoders') {
        const companionEntries = await Promise.all(
          ['generator.ts', 'encoder.ts'].map(async (entry) => {
            const path = resolve(root, 'src', group.directory, name, entry);
            return { entry, present: !!(await stat(path).catch(() => null))?.isFile() };
          }),
        );
        if (companionEntries.some((entry) => entry.present) && !companionEntries.every((entry) => entry.present))
          throw new Error(
            'Decoder generator.ts and encoder.ts must be provided together: ' +
              relative(root, resolve(root, 'src', group.directory, name)),
          );
        if (companionEntries.every((entry) => entry.present)) encoders.push(name);
      }
      await inspectUiGraph(resolve(root, 'src', group.directory, name, 'component.ts'), new Set());
      discovered.push({ ...group, name });
      exports.push(`export * from '../${group.directory}/${name}/index.js';`);
    }
    const imports = names
      .map(
        (name, index) => `import { component as component${index} } from '../${group.directory}/${name}/component.js';`,
      )
      .join('\n');
    const keys = names.map((_, index) => `keyof typeof component${index}.messages.en`).join(' | ') || 'never';
    const values = names.map((_, index) => `component${index}`).join(', ');
    await writeGenerated(
      resolve(output, group.directory + '.ts'),
      `import type { ${group.definition} } from '../${group.directory}/definition.js';\n${imports}\n\nexport type ${group.kind === 'decoder' ? 'Decoder' : 'Driver'}MessageKey = ${keys};\nexport const ${group.kind}Definitions: readonly ${group.definition}[] = [${values}];\n`,
    );
    const workerLoaders = names
      .map(
        (name) =>
          `  ${JSON.stringify(name)}: async () => (await import('../${group.directory}/${name}/worker.js')).worker,`,
      )
      .join('\n');
    const workerCap = group.kind === 'decoder' ? 'Decoder' : 'Driver';
    await writeGenerated(
      resolve(output, group.kind + '-workers.ts'),
      `import type { ${group.workerDefinition} } from '../${group.directory}/definition.js';

const loaders: Record<string, () => Promise<${group.workerDefinition}>> = {
${workerLoaders}
};

export const builtin${workerCap}WorkerIds = Object.freeze(${JSON.stringify(names)}) as readonly string[];

export function hasBuiltin${workerCap}Worker(id: string): boolean {
  return Object.hasOwn(loaders, id);
}

export async function loadBuiltin${workerCap}Worker(id: string): Promise<${group.workerDefinition} | undefined> {
  const load = Object.hasOwn(loaders, id) ? loaders[id] : undefined;
  return load ? load() : undefined;
}
`,
    );
  }
  const encoderNames = encoders.sort();
  const encoderLoaders = encoderNames
    .map(
      (name) => `  ${JSON.stringify(name)}: async () => {
    const [generator, encoder] = await Promise.all([
      import('../decoders/${name}/generator.js'),
      import('../decoders/${name}/encoder.js'),
    ]);
    return { cases: generator.cases, createEncoder: encoder.createEncoder } as SignalEncoderModule;
  },`,
    )
    .join('\n');
  await writeGenerated(
    resolve(output, 'encoders.ts'),
    `import type { SignalEncoderModule, SignalEncoderPreset } from '../decoders/signal.js';

const loaders: Record<string, () => Promise<SignalEncoderModule>> = {
${encoderLoaders}
};

export const encoderIds = Object.freeze(${JSON.stringify(encoderNames)}) as readonly string[];

export async function loadSignalEncoder(decoder: string): Promise<SignalEncoderModule> {
  const load = loaders[decoder];
  if (!load) throw new Error('Unknown signal encoder: ' + decoder);
  return load();
}

export async function loadSignalEncoderPresets(decoder: string): Promise<readonly SignalEncoderPreset[]> {
  const encoder = await loadSignalEncoder(decoder);
  return [...encoder.cases({ minimumPayloadBits: 0 })]
    .filter((item) => item.kind === 'boundary')
    .map((item) => ({
      name: item.name,
      options: { ...item.options },
      channels: Object.keys(item.channels),
      chain: (item.chain ?? []).map((node) => ({ decoder: node.decoder, options: { ...node.options } })),
    }));
}
`,
  );
  await writeGenerated(resolve(output, 'exports.ts'), exports.join('\n') + '\n');
  return discovered;
}

export async function validateComponents(discovered) {
  const keys = new Set();
  for (const { directory, kind, name } of discovered) {
    const { component } = await import(pathToFileURL(resolve(root, 'dist/src', directory, name, 'component.js')));
    const { worker } = await import(pathToFileURL(resolve(root, 'dist/src', directory, name, 'worker.js')));
    if (component.descriptor.id !== name || worker.id !== name)
      throw new Error('Component ID must match its directory: ' + directory + '/' + name);
    if (typeof worker[kind === 'decoder' ? 'createRuntime' : 'createDevice'] !== 'function')
      throw new Error('Component Worker factory is missing: ' + name);
    if (kind === 'decoder' && (typeof worker.csvHeader !== 'string' || typeof worker.csvRow !== 'function'))
      throw new Error('Decoder Worker export format is missing: ' + name);
    const prefix = kind + '.' + name + '.';
    if (!Object.hasOwn(component.messages.en, prefix + 'name'))
      throw new Error('Component name translation is missing: ' + prefix);
    for (const [locale, messages] of Object.entries(component.messages)) {
      if (!['en', 'zh-CN'].includes(locale)) throw new Error('Unsupported component locale: ' + locale);
      for (const [key, value] of Object.entries(messages)) {
        if (!key.startsWith(prefix) || typeof value !== 'string')
          throw new Error('Invalid component translation: ' + key);
        if (locale !== 'en' && !Object.hasOwn(component.messages.en, key))
          throw new Error('Translation has no English fallback: ' + key);
        if (locale === 'en') {
          if (keys.has(key)) throw new Error('Duplicate component translation: ' + key);
          keys.add(key);
        } else {
          const placeholders = (text) =>
            [...text.matchAll(/\{(\w+)\}/g)]
              .map((match) => match[1])
              .sort()
              .join(',');
          if (placeholders(value) !== placeholders(component.messages.en[key]))
            throw new Error('Translation placeholders differ: ' + key);
        }
      }
    }
    function checkReferences(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key.endsWith('Key') && typeof child === 'string' && !Object.hasOwn(component.messages.en, child))
          throw new Error('Component translation reference is missing: ' + child);
        checkReferences(child);
      }
    }
    checkReferences(component.ui);
    const options = Array.isArray(component.descriptor.options)
      ? component.descriptor.options
      : Object.keys(component.descriptor.options ?? {}).map((id) => ({ id }));
    for (const option of options) {
      if (!Object.hasOwn(component.messages.en, prefix + 'option.' + option.id))
        throw new Error('Component option translation is missing: ' + prefix + option.id);
      for (const value of option.values ?? []) {
        if (typeof value === 'string' && !Object.hasOwn(component.messages.en, prefix + 'value.' + value))
          throw new Error('Component value translation is missing: ' + prefix + value);
      }
    }
    if (kind === 'decoder') {
      const inputs = new Set(component.ui.inputs.map((input) => input.key));
      if (inputs.size !== component.ui.inputs.length) throw new Error('Duplicate decoder inputs: ' + name);
      if (component.ui.edgeInput && !inputs.has(component.ui.edgeInput))
        throw new Error('Unknown decoder edge input: ' + name);
      for (const option of component.ui.primaryOptions ?? [])
        if (!options.some((item) => item.id === option))
          throw new Error('Unknown primary decoder option: ' + name + '/' + option);
      for (const row of component.ui.rows)
        for (const index of row.classes) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= (component.descriptor.annotations?.length ?? 0))
            throw new Error('Invalid annotation class: ' + name + '/' + row.label);
        }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await generateComponents();
