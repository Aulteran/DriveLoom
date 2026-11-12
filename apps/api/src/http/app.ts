// Small HTTP layer on node:http. Feature modules export `Route[]`; this file
// owns routing, JSON bodies, cookies, authentication, CSRF/origin checks and
// problem+json rendering so modules never re-implement them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Id } from '../types.ts';
import type { Principal, RequestContext } from '../identity.ts';
import { HttpProblem, problemBody, toProblem } from './problem.ts';
import { clientIp, type IpTrust } from './ip.ts';

export interface SessionInfo {
  /** Present only for fully signed-in sessions. */
  readonly principal: Principal | null;
  readonly sessionId: Id;
  readonly userId: Id;
  readonly csrfToken: string;
  /** True for a first-factor-complete session that still needs a second factor. */
  readonly pending: boolean;
}

/** Implemented by the auth module. Resolves the `dl_session` cookie value, or null. */
export interface Authenticator {
  resolveSession(token: string): Promise<SessionInfo | null>;
}

export interface HttpRequest {
  readonly ctx: RequestContext;
  readonly session: SessionInfo | null;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: IncomingMessage['headers'];
  readonly cookies: Record<string, string>;
  readonly ip: string;
}

export interface HttpResult {
  status: number;
  body?: unknown;
  /** A non-JSON payload (image, CSV). Sent as-is with its own content type instead of `body`. */
  raw?: { data: Buffer | string; contentType: string };
  headers?: Record<string, string | string[]>;
}

/**
 * auth modes: 'required' (default) needs a signed-in session; 'optional' lets
 * anonymous callers through with ctx.principal === null; 'pending' needs a
 * first-factor-only session; 'none' never reads the session (login, register).
 */
export type AuthMode = 'required' | 'optional' | 'pending' | 'none';

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** e.g. `/v1/vehicles/:id` */
  path: string;
  auth?: AuthMode;
  /** Overrides the app-wide JSON body limit for this route (imports). */
  maxBodyBytes?: number;
  /** Accept a binary body of one of these media types; `req.body` is then `{ type, data: Buffer }`. */
  rawBody?: { types: readonly string[]; maxBytes: number };
  handler(req: HttpRequest): Promise<HttpResult>;
}

export interface AppOptions {
  routes: Route[];
  authenticator: Authenticator;
  publicOrigin: string;
  ipTrust: IpTrust;
  maxBodyBytes?: number;
}

export const SESSION_COOKIE = 'dl_session';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DISCARD_BYTES = 32 * 1024 * 1024;

interface Compiled { route: Route; re: RegExp; names: string[] }

function compile(route: Route): Compiled {
  const names: string[] = [];
  const src = route.path.replace(/:[A-Za-z]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; });
  return { route, re: new RegExp(`^${src}$`), names };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface RawBody { type: string; data: Buffer }

async function readBody(req: IncomingMessage, max: number, raw?: Route['rawBody']): Promise<unknown> {
  const limit = raw ? raw.maxBytes : max;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Past the limit, keep reading without keeping: a client that is still
    // uploading gets a clean 413 instead of a reset connection. Far past it, hang up.
    if (size > limit + DISCARD_BYTES) { req.destroy(); break; }
    if (size <= limit) chunks.push(c as Buffer);
  }
  if (size > limit) throw new HttpProblem(413, 'body_too_large', 'Request body too large');
  const type = req.headers['content-type'] ?? '';
  if (raw) {
    const media = type.split(';')[0]!.trim().toLowerCase();
    if (!raw.types.includes(media)) throw new HttpProblem(415, 'unsupported_media_type', `Expected one of: ${raw.types.join(', ')}`);
    return { type: media, data: Buffer.concat(chunks) } satisfies RawBody;
  }
  if (size === 0) return undefined;
  if (!/^application\/json(\s*;|$)/i.test(type)) throw new HttpProblem(415, 'unsupported_media_type', 'Expected application/json');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpProblem(400, 'invalid_json', 'Malformed JSON'); }
}

export function createApp(opts: AppOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const compiled = opts.routes.map(compile);
  const max = opts.maxBodyBytes ?? 64 * 1024;

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}, problem = false, raw?: HttpResult['raw']): void {
    const payload = raw ? raw.data : body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': raw ? raw.contentType : problem ? 'application/problem+json' : 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(status === 204 ? undefined : payload);
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? 'GET';
      let match: { c: Compiled; params: Record<string, string> } | null = null;
      let pathKnown = false;
      for (const c of compiled) {
        const m = c.re.exec(url.pathname);
        if (!m) continue;
        pathKnown = true;
        if (c.route.method !== method) continue;
        match = { c, params: Object.fromEntries(c.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)])) };
        break;
      }
      if (!match) throw pathKnown ? new HttpProblem(405, 'method_not_allowed', 'Method not allowed') : new HttpProblem(404, 'not_found', 'Not found');

      // Cross-site request defence: browsers send Origin on unsafe requests.
      if (UNSAFE.has(method)) {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== opts.publicOrigin) throw new HttpProblem(403, 'csrf_failed', 'Request failed anti-forgery checks');
      }

      const mode = match.c.route.auth ?? 'required';
      const cookies = parseCookies(req.headers.cookie);
      let session: SessionInfo | null = null;
      if (mode !== 'none' && cookies[SESSION_COOKIE]) session = await opts.authenticator.resolveSession(cookies[SESSION_COOKIE]!);
      if (mode === 'required' && (!session || session.pending)) throw new HttpProblem(401, 'unauthenticated', 'Authentication required');
      if (mode === 'pending' && (!session || !session.pending)) throw new HttpProblem(401, 'unauthenticated', 'Authentication required');
      if (mode === 'optional' && session?.pending) session = null;

      // Session-bound anti-forgery token for every unsafe request made with a session.
      if (UNSAFE.has(method) && session && mode !== 'none') {
        const sent = req.headers['x-csrf-token'];
        if (typeof sent !== 'string' || !safeEqual(sent, session.csrfToken)) throw new HttpProblem(403, 'csrf_failed', 'Request failed anti-forgery checks');
      }

      const body = UNSAFE.has(method) ? await readBody(req, match.c.route.maxBodyBytes ?? max, match.c.route.rawBody) : undefined;
      const result = await match.c.route.handler({
        ctx: { principal: session?.principal ?? null },
        session,
        params: match.params,
        query: url.searchParams,
        body,
        headers: req.headers,
        cookies,
        ip: clientIp(req.socket.remoteAddress ?? '', req.headers['x-forwarded-for'], opts.ipTrust),
      });
      send(res, result.status, result.body, result.headers, false, result.raw);
    } catch (err) {
      const p = toProblem(err);
      if (p.status >= 500) console.error(err);
      send(res, p.status, problemBody(p), p.headers, true);
    }
  };
}
