import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
export function createDevServer() {
  return createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('cross-origin-opener-policy', 'same-origin');
    response.setHeader('cross-origin-embedder-policy', 'require-corp');
    try {
      const url = new URL(request.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      const redirects = { '/': '/web/', '/web': '/web/', '/index.html': '/web/' };
      if (Object.hasOwn(redirects, pathname)) {
        response.writeHead(302, { location: redirects[pathname] + url.search });
        response.end();
        return;
      }
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const path = resolve(root, '.' + (pathname === '/web/' ? '/web/index.html' : pathname));
      const child = relative(root, path);
      if (child.startsWith('..') || isAbsolute(child)) throw new Error('Outside workspace');
      const content = await readFile(path);
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 4233);
  createDevServer().listen(port, '127.0.0.1', () => console.log(`Hakei UI: http://localhost:${port}/`));
}
