import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = resolve(root, 'dist');
const child = relative(root, target);
if (child !== 'dist' || isAbsolute(child)) throw new Error('Build target must be the workspace dist directory.');
await rm(target, { recursive: true, force: true });
const result = await new Promise((accept, reject) => {
  const compiler = spawn(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit', windowsHide: true });
  compiler.once('error', reject);
  compiler.once('exit', accept);
});
if (result !== 0) process.exit(typeof result === 'number' ? result : 1);
await cp(resolve(root, 'web'), target, { recursive: true });
for (const name of await readdir(target)) {
  if (!name.endsWith('.html')) continue;
  const path = resolve(target, name);
  const html = await readFile(path, 'utf8');
  await writeFile(path, html.replaceAll('../dist/src/', './src/'));
}
console.log('Built deployable static site in dist/ and ESM library, declarations and source maps in dist/src.');
