// End to end through the composition root: the same handler server.ts runs,
// with real sessions, CSRF and the web client served beside the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/application.ts';
import { ORIGIN } from './helpers/index.ts';
import { harness, PW } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const WEB = fileURLToPath(new URL('../../web/', import.meta.url));

interface Res { status: number; type: string; json: any; text: string; headers: Headers }

async function withApp(fn: (call: (method: string, path: string, o?: { body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> }) => Promise<Res>) => Promise<void>) {
  const h = (await harness({ registration: 'closed' }))!;
  const handler = createApplication(h.ctx, { webDir: WEB });
  const server = createServer((q, s) => void handler(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, o: { body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> } = {}): Promise<Res> => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: {
        origin: ORIGIN, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}), ...o.headers,
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, text, json: /json/.test(type) && text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  try { await fn(call); } finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

test('web client: files, client routes and security headers', { skip }, () => withApp(async (call) => {
  const index = await call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.type, /^text\/html/);
  assert.match(index.text, /<script type="module" src="\/js\/main\.js"><\/script>/);
  const csp = index.headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.equal(index.headers.get('strict-transport-security'), 'max-age=31536000', 'secure deployments send HSTS');
  assert.equal(index.headers.get('cache-control'), 'no-cache');

  const js = await call('GET', '/js/main.js');
  assert.equal(js.status, 200);
  assert.match(js.type, /^text\/javascript/);
  assert.equal((await call('GET', '/manifest.webmanifest')).type, 'application/manifest+json');

  // A path without an extension is a client route; a missing file is a 404.
  const route = await call('GET', '/vehicles/123');
  assert.equal(route.status, 200);
  assert.equal(route.text, index.text);
  assert.equal((await call('GET', '/js/missing.js')).status, 404);

  // Nothing outside the web directory is reachable.
  for (const p of ['/../api/package.json', '/%2e%2e/api/package.json', '/..%2fapi%2fpackage.json', '/js/..%2f..%2f..%2fapi%2fpackage.json']) {
    const r = await call('GET', p);
    assert.doesNotMatch(r.text, /"driveloom-api"/, `${p} must not escape the web directory`);
  }
  assert.equal((await call('GET', '/%E0%A4%A')).status, 400, 'malformed escapes are rejected');
  assert.equal((await call('POST', '/', { body: {} })).status, 405);

  // The API keeps its own contract: unknown /v1 paths are problem+json, never index.html.
  const missing = await call('GET', '/v1/nothing-here');
  assert.equal(missing.status, 404);
  assert.match(missing.type, /application\/problem\+json/);
  assert.equal((await call('GET', '/v1/health')).json.status, 'ok');
  const version = (await call('GET', '/v1/version')).json;
  assert.equal(typeof version.api, 'string');
  assert.ok(version.schema >= 7);
}));

test('a whole journey through the composed application', { skip }, () => withApp(async (call) => {
  const instance = (await call('GET', '/v1/auth/instance')).json;
  assert.deepEqual([instance.needs_setup, instance.registration], [true, 'closed']);

  // Bootstrap: the first account is admitted even though registration is closed, and becomes the administrator.
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'admin@example.test', password: PW, display_name: 'Admin' } })).status, 202);
  const login = await call('POST', '/v1/auth/login', { body: { email: 'admin@example.test', password: PW } });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  const csrf = login.json.csrf_token as string;
  const as = { cookie, csrf };
  const session = (await call('GET', '/v1/auth/session', { cookie })).json;
  assert.equal(session.account.instanceRole, 'admin');

  // CSRF and Origin are enforced on the composed handler too.
  assert.equal((await call('POST', '/v1/vehicles', { cookie, body: { name: 'x' } })).status, 403);
  assert.equal((await call('POST', '/v1/vehicles', { ...as, body: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);

  const v = (await call('POST', '/v1/vehicles', { ...as, body: { name: 'Golf', odometerUnit: 'km', currency: 'EUR' } })).json;
  const fill = (day: number, odo: string, vol: string, amount: string) => call('POST', `/v1/vehicles/${v.id}/fill-ups`, {
    ...as, body: { occurredAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`, odometer: { value: odo, unit: 'km' }, volume: { value: vol, unit: 'l' }, full: true, cost: { amount, currency: 'EUR' } },
  });
  assert.equal((await fill(1, '10000', '40', '70')).status, 201);
  assert.equal((await fill(15, '10600', '42', '73.50')).status, 201);
  const stats = (await call('GET', `/v1/vehicles/${v.id}/stats`, { cookie })).json;
  assert.deepEqual(stats.economy, { value: '7.00', unit: 'l_per_100km' });
  assert.deepEqual(stats.spend, { amount: '143.50', currency: 'EUR', costedFillCount: 2 });

  const csv = await call('GET', `/v1/vehicles/${v.id}/export?format=csv`, { cookie });
  assert.equal(csv.status, 200);
  assert.match(csv.type, /^text\/csv/);
  assert.equal(csv.text.trim().split('\n').length, 3);

  // Closed registration: refused without an invitation, admitted with one, and the invitation works once.
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'b@example.test', password: PW } })).json.code, 'registration_closed');
  const invite = (await call('POST', '/v1/admin/invites', { ...as, body: { email: 'b@example.test' } })).json;
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'b@example.test', password: PW, invite_token: invite.token } })).status, 202);
  assert.equal((await call('POST', '/v1/auth/register', { body: { email: 'c@example.test', password: PW, invite_token: invite.token } })).json.code, 'registration_closed');

  // Signing out ends the session for the API and the client alike.
  assert.equal((await call('POST', '/v1/auth/logout', as)).status, 204);
  assert.equal((await call('GET', '/v1/auth/session', { cookie })).status, 401);
}));
