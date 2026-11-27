// A full-stack world for API key tests: the production route table (allRoutes), the real bearer gate and
// router, a real database with a controllable clock, and users who sign in with a fake cookie session
// (`dl_session=<userId>`, CSRF `test-csrf`) so the same request can be made as a session or as a key.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp, type Authenticator, type SessionInfo } from '../../src/http/app.ts';
import { allRoutes } from '../../src/application.ts';
import { createApiKeyGate, API_KEY_LIMITS } from '../../src/auth/api-key-auth.ts';
import * as keys from '../../src/auth/api-keys.ts';
import { setModule } from '../../src/modules.ts';
import type { IpTrust } from '../../src/http/ip.ts';
import type { Id } from '../../src/types.ts';
import { createTestUser, noProxies, ORIGIN, type TestUser } from './index.ts';
import { harness, type Harness } from './auth.ts';
import { png } from './images.ts';

export interface Res { status: number; json: any; text: string; headers: Headers; bytes: Buffer }
export interface CallOpts { body?: unknown; headers?: Record<string, string>; as?: TestUser; token?: string; csrf?: boolean; raw?: { type: string; data: Uint8Array } }

export interface KeyWorld {
  h: Harness;
  db: Harness['ctx']['db'];
  base: string;
  /** One request. Pass `as` for a cookie session, `token` for a bearer key (or both, to test precedence). */
  call(method: string, path: string, o?: CallOpts): Promise<Res>;
  user(name?: string, role?: 'user' | 'admin'): Promise<TestUser>;
  /** Mint a key directly (as the owner's fresh session would) and return its id and one-time token. */
  mint(owner: TestUser, input?: Record<string, unknown>): Promise<{ id: Id; token: string; view: keys.ApiKeyView }>;
  /** A bearer-only caller. */
  bearer(token: string): (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  /** A cookie-only caller. */
  cookie(u: TestUser): (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  /** Raw HTTP, for header shapes fetch cannot produce (repeated headers, odd casing). `rawHeaders` is a flat name/value list. */
  rawRequest(method: string, path: string, rawHeaders: string[], body?: string): Promise<{ status: number; json: any; text: string }>;
}

export interface WorldOptions { limits?: Parameters<typeof createApiKeyGate>[1]; ipTrust?: IpTrust; serviceModule?: boolean }

export async function keyWorld(fn: (w: KeyWorld) => Promise<void>, opts: WorldOptions = {}): Promise<void> {
  const h = (await harness())!;
  if (opts.serviceModule !== false) await setModule(h.ctx.db, 'service', true);
  const users = new Map<string, TestUser>();
  const authenticator: Authenticator = {
    async resolveSession(token): Promise<SessionInfo | null> {
      const u = users.get(token);
      if (!u) return null;
      return { principal: u.principal, sessionId: u.principal.sessionId, userId: u.id, csrfToken: 'test-csrf', pending: false };
    },
  };
  const app = createApp({ routes: allRoutes(h.ctx, null), authenticator, publicOrigin: ORIGIN, ipTrust: opts.ipTrust ?? noProxies, apiKeys: createApiKeyGate(h.ctx, opts.limits) });
  const server = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const call: KeyWorld['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.body !== undefined && !o.raw ? { 'content-type': 'application/json' } : {}), ...(o.raw ? { 'content-type': o.raw.type } : {}) };
    if (o.as) { headers['cookie'] = `dl_session=${o.as.id}`; if (o.csrf !== false) headers['x-csrf-token'] = 'test-csrf'; }
    if (o.token) headers['authorization'] = `Bearer ${o.token}`;
    Object.assign(headers, o.headers);
    const init: RequestInit = { method, headers };
    if (o.raw) init.body = o.raw.data as Uint8Array<ArrayBuffer>;
    else if (o.body !== undefined) init.body = JSON.stringify(o.body);
    const r = await fetch(base + path, init);
    const bytes = Buffer.from(await r.arrayBuffer());
    const text = bytes.toString('utf8');
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, json: /json/.test(type) && text ? JSON.parse(text) : undefined, text, headers: r.headers, bytes };
  };

  const world: KeyWorld = {
    h, db: h.ctx.db, base, call,
    async user(name = 'u', role = 'user') {
      const u = await createTestUser(h.ctx.db, { email: `${name}-${Math.random().toString(36).slice(2, 8)}@example.test`, role });
      // The harness clock is the application's clock: sign-in "just happened".
      const principal = { ...u.principal, authenticatedAt: new Date(h.clock.t) };
      const fresh: TestUser = { ...u, principal, ctx: { principal } };
      users.set(u.id, fresh);
      return fresh;
    },
    async mint(owner, input = {}) {
      const p = { ...owner.principal, authenticatedAt: new Date(h.clock.t) };
      const out = await keys.createApiKey(h.ctx, p, keys.parseCreateInput({ name: 'test key', ...input }));
      return { id: out.key.id, token: out.token, view: out.key };
    },
    bearer: (token) => (method, path, body, headers) => call(method, path, { token, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) }),
    cookie: (u) => (method, path, body, headers) => call(method, path, { as: u, ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) }),
    rawRequest(method, path, rawHeaders, body) {
      // Hand-written HTTP/1.1 over a socket: the only way to send the same header twice with exact names.
      return new Promise((resolve, reject) => {
        const sock = connect(port, '127.0.0.1');
        const lines = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
        for (let i = 0; i < rawHeaders.length; i += 2) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
        if (body !== undefined) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
        sock.write(`${lines.join('\r\n')}\r\n\r\n${body ?? ''}`);
        const chunks: Buffer[] = [];
        sock.on('data', (c) => chunks.push(c));
        sock.on('error', reject);
        sock.on('close', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const [head, ...rest] = raw.split('\r\n\r\n');
          const text = rest.join('\r\n\r\n');
          const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head ?? '')?.[1] ?? 0);
          resolve({ status, text, json: text.includes('{') ? JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) : undefined });
        });
      });
    },
  };
  try { await fn(world); } finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

export { API_KEY_LIMITS };

/** A vehicle owned by `owner` with one of everything a key can touch. Cookie requests only. */
export interface Fixture { vehicleId: Id; fillUpId: Id; visitId: Id; itemName: string; attachmentId: Id; taskId: Id }
export async function fixture(w: KeyWorld, owner: TestUser, over: Record<string, unknown> = {}): Promise<Fixture> {
  const c = w.cookie(owner);
  const v = await c('POST', '/v1/vehicles', { name: 'Car', make: 'Honda', model: 'Odyssey', year: 2015, odometerUnit: 'km', currency: 'EUR', ...over });
  if (v.status !== 201) throw new Error(`fixture vehicle: ${v.text}`);
  const vehicleId = v.json.id as Id;
  const f = await c('POST', `/v1/vehicles/${vehicleId}/fill-ups`, { occurredAt: '2026-10-01T08:00:00Z', odometer: { value: '1000', unit: 'km' }, volume: { value: '10', unit: 'l' } });
  if (f.status !== 201) throw new Error(`fixture fill-up: ${f.text}`);
  const t = await c('POST', `/v1/vehicles/${vehicleId}/maintenance-tasks`, { name: 'Oil change', intervalDays: 365 });
  if (t.status !== 201) throw new Error(`fixture task: ${t.text}`);
  const s = await c('POST', `/v1/vehicles/${vehicleId}/service-visits`, { servicedOn: '2026-10-02', items: [{ name: 'Oil change' }, { name: 'Wipers' }] });
  if (s.status !== 201) throw new Error(`fixture visit: ${s.text}`);
  const a = await w.call('POST', `/v1/vehicles/${vehicleId}/service-visits/${s.json.id}/attachments?fileName=receipt.png`, { as: owner, raw: { type: 'image/png', data: png() } });
  if (a.status !== 201) throw new Error(`fixture attachment: ${a.text}`);
  return { vehicleId, fillUpId: f.json.id, visitId: s.json.id, itemName: 'Oil change', attachmentId: a.json.id, taskId: t.json.id };
}
export const PNG_BYTES = (): Buffer => png();
