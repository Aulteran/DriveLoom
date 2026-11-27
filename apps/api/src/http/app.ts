// Small HTTP layer on node:http. Feature modules export `Route[]`; this file
// owns routing, JSON bodies, cookies, authentication, CSRF/origin checks and
// problem+json rendering so modules never re-implement them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Id } from '../types.ts';
import type { ApiKeyPrincipal, RequestContext, SessionPrincipal } from '../identity.ts';
import type { KeyPolicy } from '../auth/api-key-policy.ts';
import { HttpProblem, problemBody, toProblem } from './problem.ts';
import { bearerTransportAllowed, clientIp, type IpTrust } from './ip.ts';

export interface SessionInfo {
  /** Present only for fully signed-in sessions. */
  readonly principal: SessionPrincipal | null;
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

/**
 * Bearer authentication and authorization for API keys, implemented by auth/api-key-auth.ts. Resolves the presented
 * token and applies the route's key policy and the key's rate limits; throws an HttpProblem on any refusal. The router
 * never reads a token itself and never falls back to the session cookie once a credential header is present.
 */
export interface ApiKeyGate {
  /** `token` is null when credentials were presented but are not exactly one well-formed `Bearer dlk_...` header. */
  authenticate(input: { token: string | null; ip: string; route: Route; params: Record<string, string>; requestId: string | null }): Promise<ApiKeyPrincipal>;
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
  /**
   * How API keys may use this route (auth/api-key-policy.ts). Declared in
   * auth/api-key-route-policies.ts and attached by allRoutes(); absent means
   * session_only. Enforced centrally by the ApiKeyGate before the body is read.
   */
  key?: KeyPolicy;
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
  /** Without a gate every request that presents a credential header is refused (401 invalid_api_key): key authentication is off. */
  apiKeys?: ApiKeyGate;
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
    if (i <= 0) continue;
    const name = part.slice(0, i).trim(), raw = part.slice(i + 1).trim();
    // A malformed value in any cookie on this host (another app, a stray
    // script) must not break every request: keep it undecoded instead of throwing.
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

/** Path parameters with malformed percent-encoding match no resource. */
function decodeParam(v: string): string {
  try { return decodeURIComponent(v); } catch { throw new HttpProblem(404, 'not_found', 'Not found'); }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface RawBody { type: string; data: Buffer }

/** Headers that look like another way of presenting a credential. Never honoured; their presence is refused outright. */
const ALTERNATE_CREDENTIAL_HEADERS = new Set(['x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token', 'x-driveloom-key', 'x-driveloom-token']);
/** Query parameters that would put a token in the URL (logged, cached, leaked in referrers). */
const ALTERNATE_CREDENTIAL_PARAMS = ['access_token', 'api_key', 'apikey'];
const BEARER_RE = /^Bearer (dlk_[A-Za-z0-9_-]{43})$/i;

/**
 * Whether the request presents credentials other than the session cookie, and the one acceptable form of them.
 * Node keeps only the first of repeated Authorization headers, so the raw header list is counted instead.
 * `token` is set only for exactly one Authorization header of the form `Bearer dlk_<43 base64url characters>`
 * and nothing else (no alternate header, no token in the query string).
 */
export function inspectCredentials(req: Pick<IncomingMessage, 'rawHeaders' | 'headers'>, query: URLSearchParams): { present: boolean; token: string | null } {
  let auth = 0, alternate = false;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (name === 'authorization') auth++;
    else if (ALTERNATE_CREDENTIAL_HEADERS.has(name)) alternate = true;
  }
  for (const k of ALTERNATE_CREDENTIAL_PARAMS) if (query.has(k)) alternate = true;
  if (auth === 0 && !alternate) return { present: false, token: null };
  const value = req.headers.authorization;
  const m = auth === 1 && !alternate && typeof value === 'string' ? BEARER_RE.exec(value) : null;
  return { present: true, token: m ? m[1]! : null };
}

/** Error text for logs: any token-shaped string is removed, and the Authorization header is never logged at all. */
export function scrubSecrets(text: string): string {
  return text.replace(/dlk_[A-Za-z0-9_-]{8,}/g, 'dlk_[redacted]');
}

async function readBody(req: IncomingMessage, max: number, raw?: Route['rawBody']): Promise<unknown> {
  const limit = raw ? raw.maxBytes : max;
  // A declared length far past the limit is refused before reading anything.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit + DISCARD_BYTES) throw new HttpProblem(413, 'body_too_large', 'Request body too large', undefined, {}, { connection: 'close' });
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

  /** The only logging in the HTTP layer: method, path (no query string) and the error, with anything token-shaped removed. */
  function logFailure(req: IncomingMessage, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(scrubSecrets(`${req.method ?? ''} ${(req.url ?? '').split('?')[0]} failed: ${e.stack ?? e.message}`));
  }

  return async (req, res) => {
    let requestId: string | null = null;
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
        match = { c, params: Object.fromEntries(c.names.map((n, i) => [n, decodeParam(m[i + 1]!)])) };
        break;
      }
      if (!match) throw pathKnown ? new HttpProblem(405, 'method_not_allowed', 'Method not allowed') : new HttpProblem(404, 'not_found', 'Not found');

      // Cross-site request defence: browsers send Origin on unsafe requests.
      if (UNSAFE.has(method)) {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== opts.publicOrigin) throw new HttpProblem(403, 'csrf_failed', 'Request failed anti-forgery checks');
      }

      const route = match.c.route;
      const mode = route.auth ?? 'required';
      const cookies = parseCookies(req.headers.cookie);
      const ip = clientIp(req.socket.remoteAddress ?? '', req.headers['x-forwarded-for'], opts.ipTrust);
      let session: SessionInfo | null = null;
      let key: ApiKeyPrincipal | null = null;
      // Credentials in an Authorization header (or any other credential header) mean API-key authentication, and
      // only that: a failure is final and never falls back to the cookie. Routes with auth 'none' ignore all credentials.
      const cred = mode === 'none' ? { present: false, token: null } : inspectCredentials(req, url.searchParams);
      if (cred.present) {
        const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
        if (!bearerTransportAllowed({ encrypted, peer: req.socket.remoteAddress ?? '', forwardedFor: req.headers['x-forwarded-for'], forwardedProto: req.headers['x-forwarded-proto'] }, opts.ipTrust)) {
          throw new HttpProblem(403, 'https_required', 'HTTPS required', 'API keys are only accepted over HTTPS (or from the local machine). Use the https:// address of this server.');
        }
        if (!opts.apiKeys) throw new HttpProblem(401, 'invalid_api_key', 'Invalid API key', 'The API key is missing, malformed, expired or revoked.');
        const rid = req.headers['x-request-id'];
        key = await opts.apiKeys.authenticate({ token: cred.token, ip, route, params: match.params, requestId: typeof rid === 'string' ? rid : null });
        requestId = key.apiKey.requestId;
      } else {
        if (mode !== 'none' && cookies[SESSION_COOKIE]) session = await opts.authenticator.resolveSession(cookies[SESSION_COOKIE]!);
        if (mode === 'required' && (!session || session.pending)) throw new HttpProblem(401, 'unauthenticated', 'Authentication required');
        if (mode === 'pending' && (!session || !session.pending)) throw new HttpProblem(401, 'unauthenticated', 'Authentication required');
        if (mode === 'optional' && session?.pending) session = null;

        // Session-bound anti-forgery token for every unsafe request made with a session. A bearer request has no session and is not subject to it.
        if (UNSAFE.has(method) && session && mode !== 'none') {
          const sent = req.headers['x-csrf-token'];
          if (typeof sent !== 'string' || !safeEqual(sent, session.csrfToken)) throw new HttpProblem(403, 'csrf_failed', 'Request failed anti-forgery checks');
        }
      }

      const body = UNSAFE.has(method) ? await readBody(req, route.maxBodyBytes ?? max, route.rawBody) : undefined;
      const result = await route.handler({
        ctx: { principal: key ?? session?.principal ?? null },
        session,
        params: match.params,
        query: url.searchParams,
        body,
        headers: req.headers,
        cookies,
        ip,
      });
      send(res, result.status, result.body, { ...(requestId ? { 'x-request-id': requestId } : {}), ...result.headers }, false, result.raw);
    } catch (err) {
      const p = toProblem(err);
      if (p.status >= 500) logFailure(req, err);
      send(res, p.status, problemBody(p), { ...(requestId ? { 'x-request-id': requestId } : {}), ...p.headers }, true);
    }
  };
}
