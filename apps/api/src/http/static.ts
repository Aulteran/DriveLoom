// Serves the web client: files from one directory, index.html for client-side
// routes, strict security headers. Nothing outside the directory is reachable.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** Same-origin only: no inline script, no third-party anything, no framing. */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function staticFiles(dir: string, opts: { secure: boolean }) {
  const root = path.resolve(dir);
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
    res.writeHead(200, headers(TYPES[path.extname(target)] ?? 'application/octet-stream', isIndex ? 'no-cache' : 'public, max-age=300'));
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
