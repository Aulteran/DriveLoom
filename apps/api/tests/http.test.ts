import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type Route } from '../src/http/app.ts';
import { clientIp, trustFromList } from '../src/http/ip.ts';
import { requirePrincipal } from '../src/identity.ts';
import { fakeAuthenticator, noProxies, ORIGIN, type TestUser } from './helpers/index.ts';
import { uuidv7 } from '../src/ids.ts';

const user: TestUser = (() => {
  const id = uuidv7();
  const principal = { userId: id, sessionId: uuidv7(), instanceRole: 'user' as const, authenticatedAt: new Date() };
  return { id, email: 'a@example.test', role: 'user', principal, ctx: { principal } };
})();

const routes: Route[] = [
  { method: 'GET', path: '/v1/whoami', handler: async (r) => ({ status: 200, body: { id: requirePrincipal(r.ctx).userId } }) },
  { method: 'POST', path: '/v1/echo/:id', handler: async (r) => ({ status: 200, body: { id: r.params['id'], body: r.body } }) },
  { method: 'GET', path: '/v1/open', auth: 'none', handler: async () => ({ status: 200, body: { ok: true } }) },
];

async function withApp(fn: (base: string) => Promise<void>) {
  const server = createServer(createApp({ routes, authenticator: fakeAuthenticator([user]), publicOrigin: ORIGIN, ipTrust: noProxies }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}
const auth = { cookie: `dl_session=${user.id}` };

test('anonymous caller gets 401 problem+json', async () => {
  await withApp(async (b) => {
    const r = await fetch(`${b}/v1/whoami`);
    assert.equal(r.status, 401);
    assert.match(r.headers.get('content-type')!, /problem\+json/);
    assert.equal(((await r.json()) as { code: string }).code, 'unauthenticated');
  });
});

test('session authenticates; unsafe methods need CSRF token and same origin', async () => {
  await withApp(async (b) => {
    assert.equal((await fetch(`${b}/v1/whoami`, { headers: auth })).status, 200);
    const post = (h: Record<string, string>) => fetch(`${b}/v1/echo/x`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...h }, body: '{"a":1}' });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await post({ 'x-csrf-token': 'test-csrf', origin: 'https://evil.test' })).status, 403);
    const ok = await post({ 'x-csrf-token': 'test-csrf', origin: ORIGIN });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { body: unknown }).body, { a: 1 });
  });
});

test('unknown path 404, wrong method 405, bad json 400, non-json 415', async () => {
  await withApp(async (b) => {
    assert.equal((await fetch(`${b}/v1/nope`)).status, 404);
    assert.equal((await fetch(`${b}/v1/open`, { method: 'POST' })).status, 405);
    const h = { ...auth, 'x-csrf-token': 'test-csrf' };
    assert.equal((await fetch(`${b}/v1/echo/x`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${b}/v1/echo/x`, { method: 'POST', headers: { ...h, 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  });
});

test('X-Forwarded-For is ignored from untrusted peers and honoured from trusted proxies', () => {
  const trust = trustFromList(['10.0.0.0/8', '::1']);
  assert.equal(clientIp('203.0.113.9', '1.2.3.4', trust), '203.0.113.9');
  assert.equal(clientIp('10.1.1.1', '198.51.100.7', trust), '198.51.100.7');
  assert.equal(clientIp('10.1.1.1', '6.6.6.6, 198.51.100.7, 10.2.2.2', trust), '198.51.100.7');
  assert.equal(clientIp('10.1.1.1', 'garbage', trust), '10.1.1.1');
  assert.equal(clientIp('::ffff:10.1.1.1', undefined, trust), '10.1.1.1');
});
