import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.ts';
import { trustFromList } from '../src/http/ip.ts';
import { authRoutes } from '../src/auth/routes.ts';
import { ORIGIN } from './helpers/index.ts';
import { currentTotp, harness, nextTotp, PW } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

async function withServer(trusted: string[], fn: (call: (method: string, path: string, o?: { body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> }) => Promise<{ status: number; json: any; setCookie: string[] }>, h: NonNullable<Awaited<ReturnType<typeof harness>>>) => Promise<void>) {
  const h = (await harness({ ipTrust: trustFromList(trusted) }))!;
  const server = createServer((q, s) => void createApp({ routes: authRoutes(h.ctx), authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, o: { body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.csrf ? { 'x-csrf-token': o.csrf } : {}), ...o.headers },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, setCookie: res.headers.getSetCookie() };
  };
  try { await fn(call, h); } finally { server.close(); await h.drop(); }
}
const cookieOf = (sc: string[]) => sc[0]!.split(';')[0]!;

test('HTTP: sign-in sets a hardened cookie; session needs it; unsafe calls need CSRF', { skip }, () => withServer([], async (call) => {
  const reg = await call('POST', '/v1/auth/register', { body: { email: 'a@example.test', password: PW } });
  assert.equal(reg.status, 202);
  const login = await call('POST', '/v1/auth/login', { body: { email: 'a@example.test', password: PW } });
  assert.equal(login.status, 200);
  assert.match(login.setCookie[0]!, /^dl_session=.+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure$/);
  const cookie = cookieOf(login.setCookie);
  const csrf = login.json.csrf_token as string;

  assert.equal((await call('GET', '/v1/auth/session')).status, 401);
  const me = await call('GET', '/v1/auth/session', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.account.email, 'a@example.test');
  assert.equal(me.json.account.credentials.password, true);

  assert.equal((await call('POST', '/v1/auth/logout', { cookie })).status, 403, 'missing CSRF token');
  assert.equal((await call('POST', '/v1/auth/logout', { cookie, csrf, headers: { origin: 'https://evil.test' } })).status, 403, 'cross-origin');
  assert.equal((await call('POST', '/v1/auth/logout', { cookie, csrf })).status, 204);
  assert.equal((await call('GET', '/v1/auth/session', { cookie })).status, 401, 'session dead after logout');
}));

test('HTTP: pending (first-factor) session cannot reach protected routes', { skip }, () => withServer([], async (call, h) => {
  await call('POST', '/v1/auth/register', { body: { email: 'a@example.test', password: PW } });
  const l1 = await call('POST', '/v1/auth/login', { body: { email: 'a@example.test', password: PW } });
  const c1 = cookieOf(l1.setCookie);
  const tb = await call('POST', '/v1/auth/totp', { cookie: c1, csrf: l1.json.csrf_token });
  const secret = tb.json.secret as string;
  await call('POST', '/v1/auth/totp/confirm', { cookie: c1, csrf: l1.json.csrf_token, body: { code: await currentTotp(h, secret) } });

  const l2 = await call('POST', '/v1/auth/login', { body: { email: 'a@example.test', password: PW } });
  assert.equal(l2.json.state, 'mfa_required');
  const pend = cookieOf(l2.setCookie);
  assert.equal((await call('GET', '/v1/auth/session', { cookie: pend })).status, 401);
  assert.equal((await call('GET', '/v1/auth/sessions', { cookie: pend })).status, 401);
  // The pending cookie is useless on a normal-session endpoint but works for the second factor, and only with a code.
  assert.equal((await call('POST', '/v1/auth/mfa/totp', { cookie: pend, csrf: l2.json.csrf_token, body: { code: '123456' } })).status, 401);
  const done = await call('POST', '/v1/auth/mfa/totp', { cookie: pend, csrf: l2.json.csrf_token, body: { code: await nextTotp(h, secret) } });
  assert.equal(done.status, 200);
  assert.equal(done.json.state, 'signed_in');
  assert.equal((await call('GET', '/v1/auth/session', { cookie: cookieOf(done.setCookie) })).status, 200);
  assert.equal((await call('GET', '/v1/auth/session', { cookie: pend })).status, 401, 'pending session replaced');
}));

test('HTTP: a spoofed X-Forwarded-For from an untrusted peer does not evade rate limits', { skip }, () => withServer([], async (call) => {
  await call('POST', '/v1/auth/register', { body: { email: 'a@example.test', password: PW } });
  const statuses: number[] = [];
  for (let i = 0; i < 32; i++) {
    statuses.push((await call('POST', '/v1/auth/login', { body: { email: `nobody${i}@example.test`, password: 'x'.repeat(12) }, headers: { 'x-forwarded-for': `203.0.113.${i}` } })).status);
  }
  assert.equal(statuses.at(-1), 429, 'IP limit applies to the real peer, not the header');
}));

test('HTTP: the same header from a trusted proxy is honoured, so clients are limited separately', { skip }, () => withServer(['127.0.0.1'], async (call) => {
  const statuses: number[] = [];
  for (let i = 0; i < 32; i++) {
    statuses.push((await call('POST', '/v1/auth/login', { body: { email: `nobody${i}@example.test`, password: 'x'.repeat(12) }, headers: { 'x-forwarded-for': `203.0.113.${i}` } })).status);
  }
  assert.ok(statuses.every((s) => s === 401));
}));

test('HTTP: malformed and oversized input gets problem+json, not a crash', { skip }, () => withServer([], async (call) => {
  assert.equal((await call('POST', '/v1/auth/login', { body: [] })).status, 400);
  assert.equal((await call('POST', '/v1/auth/login', { body: { email: 5, password: {} } })).status, 400);
  const big = await call('POST', '/v1/auth/login', { body: { email: 'a@example.test', password: 'x'.repeat(100_000) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'body_too_large');
}));
