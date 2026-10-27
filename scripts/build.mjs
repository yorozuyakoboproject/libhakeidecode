import { rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { generateComponents, validateComponents } from './generate-components.mjs';
import { runDecoderRoundtrips } from '../tests/decoder-roundtrip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const components = await generateComponents();
const target = resolve(root, 'dist');
const child = relative(root, target);
if (child !== 'dist' || isAbsolute(child)) throw new Error('Build target must be the workspace dist directory.');
await rm(target, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
);
await validateComponents(components);
await runDecoderRoundtrips(components);
await build({ root });
console.log('Built deployable static site in dist/ and ESM library, declarations and source maps in dist/src.');
