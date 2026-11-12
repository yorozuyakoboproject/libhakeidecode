import { rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import { generateComponents, validateComponents } from './generate-components.mjs';
import { runDecoderRoundtrips } from '../tests/decoder-roundtrip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const decoderRoundtrip = process.argv.includes('--decoder-roundtrip') || process.env.DECODER_ROUNDTRIP === '1';
const buildStarted = performance.now();
console.log('[build] generate component registries');
const components = await generateComponents();
const target = resolve(root, 'dist');
const child = relative(root, target);
if (child !== 'dist' || isAbsolute(child)) throw new Error('Build target must be the workspace dist directory.');
await rm(target, { recursive: true, force: true });
console.log('[build] compile TypeScript');
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
);
console.log('[build] validate components');
await validateComponents(components);
if (decoderRoundtrip) {
  console.log('[build] decoder roundtrip');
  const roundtripStarted = performance.now();
  try {
    await runDecoderRoundtrips(components);
  } finally {
    console.log(`[decoder roundtrip] elapsed ${((performance.now() - roundtripStarted) / 1000).toFixed(3)} s`);
  }
} else {
  console.log('[build] decoder roundtrip skipped (use npm run build:roundtrip)');
}
console.log('[build] bundle site and library');
await build({ root });
console.log(
  `Built deployable static site in dist/ and ESM library, declarations and source maps in dist/src. (${(
    (performance.now() - buildStarted) /
    1000
  ).toFixed(3)} s)`,
);
