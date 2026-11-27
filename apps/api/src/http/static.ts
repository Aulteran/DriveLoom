// Serves the web client: files from one directory, index.html for client-side
// routes, strict security headers. Nothing outside the directory is reachable.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.yaml': 'application/yaml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** Same-origin only: no inline script, no third-party anything, no framing. */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Every file under the web directory, as sorted URL paths relative to it. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.isFile()) out.push(`${prefix}${e.name}`);
    }
  };
  try { walk(root, ''); } catch { /* missing directory: nothing to serve */ }
  return out.sort();
}

/**
 * Service worker source with its build id and precache list injected. The id is a
 * sha256 over every web file's path and bytes, so it changes exactly when the client
 * changes and is identical across restarts for identical files. Null without a sw.js.
 */
export function buildServiceWorker(dir: string): { source: string; build: string; precache: string[] } | null {
  const root = path.resolve(dir);
  const files = listFiles(root);
  if (!files.includes('sw.js')) return null;
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update('\0').update(readFileSync(path.join(root, f))).update('\0');
  const build = hash.digest('hex').slice(0, 16);
  // The app shell only: no service worker, no licence texts, no API docs (a public page of its own), nothing dot-prefixed.
  const precache = files.filter((f) => f !== 'sw.js' && !f.endsWith('.txt') && !f.startsWith('docs/') && !f.split('/').some((p) => p.startsWith('.')))
    .map((f) => (f === 'index.html' ? '/' : `/${encodeURI(f)}`));
  const source = readFileSync(path.join(root, 'sw.js'), 'utf8')
    // Function replacers: a `$&` or `$1` in a file name must not be read as a replacement pattern.
    .replace("'__BUILD__'", () => JSON.stringify(build))
    .replace('/*PRECACHE*/ []', () => JSON.stringify(precache));
  return { source, build, precache };
}

export function staticFiles(dir: string, opts: { secure: boolean }) {
  const root = path.resolve(dir);
  const sw = buildServiceWorker(root);
  const headers = (type: string, cache: string): Record<string, string> => ({
    'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': CSP, 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    ...(opts.secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  });
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }); res.end('Method not allowed'); return;
    }
    let rel: string;
    try { rel = decodeURIComponent((req.url ?? '/').split('?')[0]!); } catch { res.writeHead(400); res.end(); return; }
    if (sw && rel === '/sw.js') {
      res.writeHead(200, { ...headers(TYPES['.js']!, 'no-cache'), 'service-worker-allowed': '/' });
      res.end(req.method === 'HEAD' ? undefined : sw.source); return;
    }
    // The API docs are a real page, never the client's index.html.
    if (rel === '/docs' || rel === '/docs/') rel = '/docs/index.html';
    const file = path.resolve(root, `.${path.posix.normalize(rel)}`);
    let target = file;
    const inside = file === root || file.startsWith(root + path.sep);
    const isFile = inside && (await stat(file).then((s) => s.isFile(), () => false));
    if (!isFile) {
      // Unknown paths with an extension are real 404s; anything else is a client route.
      if (path.extname(rel)) { res.writeHead(404, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' }); res.end('Not found'); return; }
      target = path.join(root, 'index.html');
    }
    const body = await readFile(target);
    const isIndex = path.basename(target) === 'index.html';
    res.writeHead(200, headers(TYPES[path.extname(target)] ?? 'application/octet-stream', isIndex || path.basename(target) === 'manifest.webmanifest' ? 'no-cache' : 'public, max-age=300'));
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
