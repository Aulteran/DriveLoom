// Serves the API contract (the same openapi/openapi.yaml the build validates) at /openapi.yaml and as JSON at
// /openapi.json, for the self-hosted docs page. Public static data: no credentials, nothing per user.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

const SPEC = new URL('../../openapi/openapi.yaml', import.meta.url);

export const OPENAPI_PATHS = ['/openapi.yaml', '/openapi.json'] as const;
export const isOpenApiPath = (p: string): boolean => (OPENAPI_PATHS as readonly string[]).includes(p);

export function openApiHandler(opts: { secure: boolean; file?: URL }) {
  const file = opts.file ?? SPEC;
  let cache: Promise<{ yaml: string; json: string }> | null = null;
  const load = () => (cache ??= (async () => {
    const yaml = await readFile(file, 'utf8');
    // The parser is loaded on first use, so an API-only start never needs it.
    const { parse } = await import('yaml');
    return { yaml, json: JSON.stringify(parse(yaml)) };
  })().catch((e) => { cache = null; throw e; }));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }); res.end('Method not allowed'); return; }
    const path = (req.url ?? '/').split('?')[0];
    let doc: { yaml: string; json: string };
    try { doc = await load(); } catch { res.writeHead(404, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' }); res.end('Not found'); return; }
    const yaml = path === '/openapi.yaml';
    res.writeHead(200, {
      'content-type': yaml ? 'application/yaml; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      ...(opts.secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : yaml ? doc.yaml : doc.json);
  };
}
