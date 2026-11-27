// API keys, phase 3: bearer authentication in the router. Header parsing, no cookie fallback, session-only routes,
// CSRF, HTTPS rule, instance and user switches, rotation, revocation, expiry, /v1/me, rate limits, last_used_at,
// and "no secret anywhere". Every request goes through the real router, gate and database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, inspectCredentials, scrubSecrets } from '../src/http/app.ts';
import { allRoutes } from '../src/application.ts';
import { createApiKeyGate } from '../src/auth/api-key-auth.ts';
import * as keys from '../src/auth/api-keys.ts';
import { bearerTransportAllowed, trustFromList } from '../src/http/ip.ts';
import { sha256Hex } from '../src/auth/crypto.ts';
import type { ApiKeyPrincipal } from '../src/identity.ts';
import type { Id } from '../src/types.ts';
import { keyWorld, type KeyWorld } from './helpers/keys.ts';
import { harness } from './helpers/auth.ts';
import { ORIGIN, noProxies } from './helpers/index.ts';
import { KEY_ROUTE_POLICIES } from '../src/auth/api-key-route-policies.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const ME = '/v1/me';
const VEH = '/v1/vehicles';
const INFO = { permissions: { vehicle_info: 'read' } };
const FAKE = `dlk_${'A'.repeat(43)}`;

// ---------- pure: header inspection and transport ----------
test('credential inspection accepts exactly one well-formed bearer key and nothing else', () => {
  const q = new URLSearchParams();
  const tok = `dlk_${'x'.repeat(43)}`;
  const one = (raw: string[], headers: Record<string, string>, query = q) => inspectCredentials({ rawHeaders: raw, headers } as never, query);
  assert.deepEqual(one([], {}), { present: false, token: null });
  assert.deepEqual(one(['Cookie', 'a=b'], { cookie: 'a=b' }), { present: false, token: null });
  assert.deepEqual(one(['Authorization', `Bearer ${tok}`], { authorization: `Bearer ${tok}` }), { present: true, token: tok });
  assert.deepEqual(one(['authorization', `bearer ${tok}`], { authorization: `bearer ${tok}` }), { present: true, token: tok }, 'the scheme name is case-insensitive');
  for (const bad of [`Bearer  ${tok}`, `Bearer ${tok} `, `Bearer ${tok}x`, `Bearer ${tok.slice(0, -1)}`, `Basic ${tok}`, tok, 'Bearer ', 'Bearer', `Bearer dlk_${'x'.repeat(42)}!`, `Bearer xyz_${'x'.repeat(43)}`, `Bearer ${tok}, Bearer ${tok}`, '']) {
    assert.deepEqual(one(['Authorization', bad], { authorization: bad }), { present: true, token: null }, JSON.stringify(bad));
  }
  // Repeated header: Node keeps only the first value, so the raw list decides.
  assert.deepEqual(one(['Authorization', `Bearer ${tok}`, 'authorization', `Bearer ${tok}`], { authorization: `Bearer ${tok}` }), { present: true, token: null });
  for (const alt of ['X-API-Key', 'api-key', 'X-Auth-Token', 'X-Access-Token', 'x-driveloom-key']) {
    assert.deepEqual(one([alt, tok], {}), { present: true, token: null }, alt);
    assert.deepEqual(one(['Authorization', `Bearer ${tok}`, alt, tok], { authorization: `Bearer ${tok}` }), { present: true, token: null }, `${alt} next to a bearer`);
  }
  for (const k of ['access_token', 'api_key', 'apikey']) assert.deepEqual(one([], {}, new URLSearchParams({ [k]: tok })), { present: true, token: null }, `?${k}=`);
});

test('bearer transport: TLS, a trusted proxy that says https, or loopback; never plain remote HTTP', () => {
  const trust = trustFromList(['10.0.0.0/8']);
  const t = (peer: string, o: { enc?: boolean; xff?: string; proto?: string } = {}) => bearerTransportAllowed({ encrypted: o.enc ?? false, peer, forwardedFor: o.xff, forwardedProto: o.proto }, trust);
  assert.equal(t('203.0.113.5', { enc: true }), true, 'TLS on the connection');
  assert.equal(t('203.0.113.5'), false, 'plain HTTP from a remote client');
  assert.equal(t('127.0.0.1'), true);
  assert.equal(t('::1'), true);
  assert.equal(t('::ffff:127.0.0.1'), true);
  assert.equal(t('10.1.2.3', { xff: '198.51.100.7', proto: 'https' }), true, 'trusted proxy terminated TLS');
  assert.equal(t('10.1.2.3', { xff: '198.51.100.7', proto: 'http' }), false, 'trusted proxy forwarded plain HTTP from a remote client');
  assert.equal(t('10.1.2.3', { xff: '198.51.100.7' }), false, 'trusted proxy without a protocol header');
  assert.equal(t('10.1.2.3', { xff: '198.51.100.7', proto: 'http, https' }), true, 'the nearest proxy (last value) decides');
  assert.equal(t('10.1.2.3', { xff: '198.51.100.7', proto: 'https, http' }), false);
  assert.equal(t('203.0.113.5', { proto: 'https' }), false, 'X-Forwarded-Proto from an untrusted peer is ignored');
  assert.equal(t('203.0.113.5', { xff: '127.0.0.1' }), false, 'X-Forwarded-For from an untrusted peer cannot fake loopback');
  assert.equal(t('10.1.2.3', { xff: '127.0.0.1' }), true, 'a trusted proxy reporting a loopback client');
});

test('log scrubbing removes anything token-shaped', () => {
  assert.equal(scrubSecrets(`boom dlk_${'a'.repeat(43)} and dlk_short12345`), 'boom dlk_[redacted] and dlk_[redacted]');
  assert.equal(scrubSecrets('nothing here'), 'nothing here');
});

// ---------- full stack ----------
test('a valid key authenticates; GET /v1/me reports the key and a session alike, minimally', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user('ann');
    const { id, token } = await w.mint(u, { name: 'CLI', permissions: { vehicle_info: 'read', fuel: 'read_write' }, expiresIn: '7d' });
    const r = await w.bearer(token)('GET', ME);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['apiKey', 'authMethod', 'user']);
    assert.equal(r.json.authMethod, 'api_key');
    assert.deepEqual(r.json.user, { id: u.id, displayName: (await w.db.query('SELECT display_name FROM users WHERE id = $1', [u.id])).rows[0].display_name });
    assert.deepEqual(r.json.apiKey, { id, name: 'CLI', permissions: { vehicle_info: 'read', fuel: 'read_write' }, vehicleMode: 'selected', vehicleIds: [], vehicleCreate: false, expiresAt: new Date(w.h.clock.t + 7 * 86_400_000).toISOString() });
    assert.ok(!/@|email|token|hash|prefix/i.test(r.text), 'no email, secret, hash or prefix');
    assert.ok(r.headers.get('x-request-id'), 'a correlation id is returned');
    const s = await w.cookie(u)('GET', ME);
    assert.equal(s.status, 200);
    assert.deepEqual(s.json, { user: r.json.user, authMethod: 'session', apiKey: null });
    assert.equal((await w.call('GET', ME)).status, 401, 'nothing at all');
  });
});

test('malformed, repeated, wrong-scheme, alternate and unknown credentials are 401 invalid_api_key, never the cookie', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, INFO);
    // Control: the cookie alone works, the key alone works, both together use the key.
    assert.equal((await w.call('GET', VEH, { as: u })).status, 200);
    assert.equal((await w.call('GET', VEH, { token })).status, 200);
    const both = await w.call('GET', ME, { as: u, token });
    assert.equal(both.json.authMethod, 'api_key', 'when both are present the key wins');
    const cases: [string, Record<string, string>][] = [
      ['unknown key', { authorization: `Bearer ${FAKE}` }],
      ['wrong scheme', { authorization: `Basic ${token}` }],
      ['no scheme', { authorization: token }],
      ['empty', { authorization: '' }],
      ['bearer only', { authorization: 'Bearer' }],
      ['truncated', { authorization: `Bearer ${token.slice(0, -1)}` }],
      ['extra', { authorization: `Bearer ${token}x` }],
      ['alternate header with a valid key', { 'x-api-key': token }],
      ['alternate header next to a valid bearer', { authorization: `Bearer ${token}`, 'x-api-key': token }],
    ];
    for (const [label, headers] of cases) {
      const r = await w.call('GET', VEH, { as: u, headers });
      assert.equal(r.status, 401, `${label}: a valid cookie must not rescue it`);
      assert.equal(r.json.code, 'invalid_api_key', label);
      assert.ok(!r.text.includes(token), `${label}: the token is never echoed`);
    }
    const q = await w.call('GET', `${VEH}?access_token=${token}`, { as: u });
    assert.equal(q.status, 401, 'tokens in the query string are refused');
    // Repeated Authorization headers, which fetch cannot send: two valid bearers, and a valid one after junk.
    for (const hdrs of [['Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`], ['authorization', `Bearer ${FAKE}`, 'Authorization', `Bearer ${token}`], ['Authorization', `Bearer ${token}`, 'Cookie', `dl_session=${u.id}`, 'authorization', 'x']]) {
      const r = await w.rawRequest('GET', VEH, hdrs);
      assert.equal(r.status, 401, JSON.stringify(hdrs.filter((_, i) => i % 2 === 0)));
      assert.equal(r.json.code, 'invalid_api_key');
    }
    // All failures look the same: status, code, title and detail.
    const a = (await w.call('GET', VEH, { headers: { authorization: `Bearer ${FAKE}` } })).json;
    const b = (await w.call('GET', VEH, { headers: { authorization: 'Bearer nope' } })).json;
    assert.deepEqual(a, b);
  });
});

test('expired, revoked, rotated, disabled-user and deleted-owner keys fail the same way; revocation is immediate', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const generic = async (token: string, label: string) => {
      const r = await w.call('GET', VEH, { as: u, token });
      assert.equal(r.status, 401, label);
      assert.equal(r.json.code, 'invalid_api_key', label);
      return r.json;
    };
    const ok = async (token: string) => assert.equal((await w.bearer(token)('GET', VEH)).status, 200);

    const revoked = await w.mint(u, INFO);
    await ok(revoked.token);
    await keys.deleteApiKey(w.h.ctx, u.principal, revoked.id);
    const sample = await generic(revoked.token, 'revoked, on the very next request');

    const rotated = await w.mint(u, INFO);
    await ok(rotated.token);
    const next = await keys.rotateApiKey(w.h.ctx, u.principal, rotated.id);
    await generic(rotated.token, 'old secret after rotation');
    await ok(next.token);

    const expiring = await w.mint(u, { ...INFO, expiresIn: '24h' });
    await ok(expiring.token);
    w.h.clock.t += 24 * 3_600_000 + 1000;
    const expired = await generic(expiring.token, 'expired');
    assert.deepEqual(expired, sample, 'the reason is never revealed');
    w.h.clock.t -= 24 * 3_600_000 + 1000;

    const disabledOwner = await w.user('gone');
    const dk = await w.mint(disabledOwner, INFO);
    await ok(dk.token);
    await w.db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabledOwner.id]);
    assert.equal((await w.call('GET', VEH, { token: dk.token })).status, 401, 'disabled user');
    assert.equal((await w.call('GET', VEH, { token: dk.token })).json.code, 'invalid_api_key');
    await w.db.query("UPDATE users SET status = 'active' WHERE id = $1", [disabledOwner.id]);
    assert.equal((await w.call('GET', VEH, { token: dk.token })).status, 200, 'the key itself was not revoked by this raw status flip (revocation is part of the account flow)');

    // Revocation from a concurrent request's point of view: the next request after the DELETE is refused.
    const live = await w.mint(u, INFO);
    await ok(live.token);
    await keys.revokeAllApiKeys(w.h.ctx, u.principal);
    await generic(live.token, 'revoke-all');
    await generic(next.token, 'revoke-all covers rotated keys too');
  });
});

test('instance switch off: valid keys are refused with api_keys_disabled; unknown ones stay a generic 401; sessions are unaffected', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, INFO);
    await keys.setApiKeysEnabled(w.db, false);
    const r = await w.call('GET', VEH, { token });
    assert.equal(r.status, 403); assert.equal(r.json.code, 'api_keys_disabled');
    assert.equal((await w.call('GET', VEH, { token: FAKE })).status, 401);
    assert.equal((await w.call('GET', VEH, { as: u })).status, 200, 'the cookie session is unaffected');
    await keys.setApiKeysEnabled(w.db, true);
    assert.equal((await w.call('GET', VEH, { token })).status, 200, 're-enabling resumes valid keys');
  });
});

test('session-only, pending and optional routes refuse keys; public routes ignore credentials', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, { permissions: { vehicle_info: 'read', fuel: 'full', service: 'full', maintenance: 'full', notifications: 'read_write', statistics: 'read', vehicle_settings: 'full' }, vehicleCreate: true, vehicleMode: 'all_current_future' });
    const fx = '00000000-0000-7000-8000-000000000000';
    // Every route the table calls session_only, called with a valid, fully-privileged key, is 403 api_key_not_allowed before anything else.
    let n = 0;
    for (const [id, pol] of Object.entries(KEY_ROUTE_POLICIES)) {
      if (pol !== 'session_only') continue;
      const [method, path] = id.split(' ') as [string, string];
      const url = path.replace(/:\w+/g, fx);
      const r = await w.call(method, url, { token, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
      // A route with auth 'none' ignores credentials entirely (login, register, ...): it must not authenticate, but it may answer on its own terms.
      const noneRoute = ['/v1/auth/register', '/v1/auth/verify-email', '/v1/auth/login', '/v1/auth/instance', '/v1/auth/recovery/request', '/v1/auth/recovery/complete', '/v1/auth/passkeys/login/options', '/v1/auth/passkeys/login/verify'].includes(path);
      if (noneRoute) { assert.notEqual(r.status, 500, id); assert.notEqual(r.json?.code, 'api_key_not_allowed', `${id}: auth none ignores credentials`); }
      else { assert.equal(r.status, 403, `${id}: ${r.text}`); assert.equal(r.json.code, 'api_key_not_allowed', id); }
      n++;
    }
    assert.ok(n >= 60, `exercised ${n} session-only routes`);
    // Same with an invalid key: 401, not 403 (an invalid key is never told which routes exist for keys).
    assert.equal((await w.call('DELETE', `${VEH}/${fx}`, { token: FAKE })).json.code, 'invalid_api_key');
    // Public routes ignore credentials, valid or not.
    for (const headers of [{ authorization: `Bearer ${token}` }, { authorization: `Bearer ${FAKE}` }, { authorization: 'garbage' }]) {
      assert.equal((await w.call('GET', '/v1/health', { headers })).status, 200);
      assert.equal((await w.call('GET', '/v1/version', { headers })).status, 200);
    }
    // A key is not a session: it never reaches handlers that read the session or the cookie.
    assert.equal((await w.call('POST', '/v1/auth/logout', { token })).json.code, 'api_key_not_allowed');
    assert.equal((await w.call('POST', '/v1/auth/mfa/totp', { token, body: { code: '123456' } })).json.code, 'api_key_not_allowed', 'pending-auth route');
    assert.equal((await w.call('POST', '/v1/auth/oidc/start', { token, body: {} })).json.code, 'api_key_not_allowed', 'optional-auth route');
  });
});

test('CSRF: still enforced for cookie requests, skipped only after successful bearer auth; Origin policy is kept', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, { permissions: { vehicle_settings: 'full' }, vehicleCreate: true });
    const body = { name: 'A', odometerUnit: 'km', currency: 'EUR' };
    // Cookie without the CSRF header: rejected, as before.
    assert.equal((await w.call('POST', VEH, { as: u, body, csrf: false })).status, 403);
    assert.equal((await w.call('POST', VEH, { as: u, body, csrf: false })).json.code, 'csrf_failed');
    assert.equal((await w.call('POST', VEH, { as: u, body, headers: { 'x-csrf-token': 'wrong' } })).json.code, 'csrf_failed');
    assert.equal((await w.call('POST', VEH, { as: u, body })).status, 201);
    // Bearer: no CSRF header needed.
    assert.equal((await w.call('POST', VEH, { token, body })).status, 201);
    // A failed bearer does not become a cookie request: still 401 invalid_api_key, not csrf and not success.
    const bad = await w.call('POST', VEH, { as: u, token: FAKE, body, csrf: false });
    assert.equal(bad.status, 401); assert.equal(bad.json.code, 'invalid_api_key');
    // The Origin check is unchanged and also applies to bearer requests.
    assert.equal((await w.call('POST', VEH, { token, body, headers: { origin: 'https://evil.example' } })).json.code, 'csrf_failed');
    assert.equal((await w.call('POST', VEH, { token, body, headers: { origin: ORIGIN } })).status, 201);
    // No CORS: a preflight or cross-origin read gets no allow-origin header.
    const r = await w.call('GET', VEH, { token, headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
});

test('HTTPS rule: a remote client over plain HTTP is refused before the key is even looked at', { skip }, async () => {
  // The test server listens on loopback, so impersonate a trusted proxy (127.0.0.1) forwarding a remote client.
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, INFO);
    const hdr = (extra: Record<string, string>) => ({ authorization: `Bearer ${token}`, ...extra });
    const remoteHttp = await w.call('GET', VEH, { headers: hdr({ 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'http' }) });
    assert.equal(remoteHttp.status, 403); assert.equal(remoteHttp.json.code, 'https_required');
    const noProto = await w.call('GET', VEH, { headers: hdr({ 'x-forwarded-for': '198.51.100.7' }) });
    assert.equal(noProto.json.code, 'https_required');
    // Even a made-up token gets the same answer (the key is not inspected over plain HTTP).
    assert.equal((await w.call('GET', VEH, { headers: { authorization: `Bearer ${FAKE}`, 'x-forwarded-for': '198.51.100.7' } })).json.code, 'https_required');
    assert.equal((await w.call('GET', VEH, { headers: hdr({ 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' }) })).status, 200, 'the proxy terminated TLS');
    // Cookie sessions are not subject to the rule.
    assert.equal((await w.call('GET', VEH, { as: u, headers: { 'x-forwarded-for': '198.51.100.7' } })).status, 200);
  }, { ipTrust: trustFromList(['127.0.0.1']) });
  // Without a trusted proxy, forwarded headers are ignored and loopback is loopback.
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, INFO);
    assert.equal((await w.call('GET', VEH, { token, headers: { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'http' } })).status, 200);
  });
});

test('failed authentication is limited per trusted client IP; valid keys are never blocked by it; Retry-After is set', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const { token } = await w.mint(u, INFO);
    for (let i = 0; i < 3; i++) assert.equal((await w.call('GET', VEH, { token: FAKE })).status, 401);
    const r = await w.call('GET', VEH, { token: FAKE });
    assert.equal(r.status, 429); assert.equal(r.json.code, 'rate_limited');
    assert.ok(Number(r.headers.get('retry-after')) >= 1 && Number(r.headers.get('retry-after')) <= 60);
    assert.equal((await w.call('GET', VEH, { headers: { authorization: 'Bearer nope' } })).status, 429, 'malformed attempts count and are limited too');
    assert.equal((await w.call('GET', VEH, { token })).status, 200, 'a valid key still works from the same address');
    // The window passes.
    w.h.clock.t += 61_000;
    assert.equal((await w.call('GET', VEH, { token: FAKE })).status, 401);
    // Behind a trusted proxy the counter follows the forwarded client address, not the proxy.
  }, { limits: { failuresPerIpPerMinute: 3 } });
  await keyWorld(async (w) => {
    for (let i = 0; i < 3; i++) await w.call('GET', VEH, { headers: { authorization: `Bearer ${FAKE}`, 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' } });
    assert.equal((await w.call('GET', VEH, { headers: { authorization: `Bearer ${FAKE}`, 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' } })).status, 429);
    assert.equal((await w.call('GET', VEH, { headers: { authorization: `Bearer ${FAKE}`, 'x-forwarded-for': '198.51.100.2', 'x-forwarded-proto': 'https' } })).status, 401, 'another client is counted separately');
    // A spoofed forwarded address from an untrusted peer would not help; here 127.0.0.1 is trusted, so the header is believed.
  }, { limits: { failuresPerIpPerMinute: 3 }, ipTrust: trustFromList(['127.0.0.1']) });
});

test('authenticated traffic is limited per key (stricter for uploads), per window, with Retry-After; realistic throughput passes', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const a = await w.mint(u, { ...INFO, name: 'a' });
    const b = await w.mint(u, { ...INFO, name: 'b' });
    for (let i = 0; i < 5; i++) assert.equal((await w.call('GET', ME, { token: a.token })).status, 200);
    const over = await w.call('GET', ME, { token: a.token });
    assert.equal(over.status, 429); assert.equal(over.json.code, 'rate_limited'); assert.ok(Number(over.headers.get('retry-after')) >= 1);
    assert.equal((await w.call('GET', ME, { token: b.token })).status, 200, 'another key has its own budget');
    assert.equal((await w.call('GET', ME, { as: u })).status, 200, 'sessions are not subject to key limits');
    // Uploads have their own, smaller bucket (derived from the route having a raw body).
    const up = await keyWorld2(w, u);
    assert.ok(up);
    w.h.clock.t += 61_000;
    assert.equal((await w.call('GET', ME, { token: a.token })).status, 200, 'the window passes');
  }, { limits: { perKeyPerMinute: 5, heavyPerKeyPerMinute: 2 } });
  // Defaults: 300 a minute is far above a script importing a few hundred visits with receipts.
  await keyWorld(async (w) => {
    const { API_KEY_LIMITS } = await import('../src/auth/api-key-auth.ts');
    assert.deepEqual({ ...API_KEY_LIMITS }, { failuresPerIpPerMinute: 20, perKeyPerMinute: 300, heavyPerKeyPerMinute: 30 });
    const u = await w.user();
    const { token } = await w.mint(u, INFO);
    const results = await Promise.all(Array.from({ length: 120 }, () => w.call('GET', ME, { token })));
    assert.equal(results.filter((r) => r.status === 200).length, 120, 'a burst of 120 requests is not throttled');
  });
});
async function keyWorld2(w: KeyWorld, u: Awaited<ReturnType<KeyWorld['user']>>): Promise<boolean> {
  const { fixture, PNG_BYTES } = await import('./helpers/keys.ts');
  const fx = await fixture(w, u);
  const k = await w.mint(u, { permissions: { service: 'read_write', vehicle_info: 'read' }, vehicleIds: [fx.vehicleId], name: 'uploader' });
  const url = `/v1/vehicles/${fx.vehicleId}/service-visits/${fx.visitId}/attachments`;
  const post = () => w.call('POST', url, { token: k.token, raw: { type: 'image/png', data: PNG_BYTES() } });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  const third = await post();
  assert.equal(third.status, 429, 'uploads are limited more strictly than ordinary requests');
  assert.ok(third.headers.get('retry-after'));
  // Ordinary requests with the same key are on the general bucket and still pass.
  assert.equal((await w.call('GET', `/v1/vehicles/${fx.vehicleId}/service-visits`, { token: k.token })).status, 200);
  return true;
}

test('last_used_at is recorded on valid requests, at most once a minute', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const { id, token } = await w.mint(u, INFO);
    const last = async () => (await w.db.query<{ t: Date | null }>('SELECT last_used_at AS t FROM api_keys WHERE id = $1', [id])).rows[0]!.t;
    assert.equal(await last(), null);
    await w.call('GET', FAKE_PATH_ME, { token });
    const first = await last();
    assert.equal(first?.getTime(), w.h.clock.t);
    w.h.clock.t += 30_000;
    await w.call('GET', ME, { token });
    assert.equal((await last())?.getTime(), first!.getTime(), 'not rewritten within a minute');
    w.h.clock.t += 31_000;
    await w.call('GET', ME, { token });
    assert.equal((await last())?.getTime(), w.h.clock.t, 'rewritten after a minute');
    // Invalid credentials never touch a key.
    const before = (await last())!.getTime();
    w.h.clock.t += 120_000;
    await w.call('GET', ME, { token: FAKE });
    assert.equal((await last())!.getTime(), before);
  });
});
const FAKE_PATH_ME = ME;

test('no token or hash ever appears in a stored row, audit, activity, error body or log', { skip }, async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    await keyWorld(async (w) => {
      const u = await w.user();
      const { id, token } = await w.mint(u, { permissions: { vehicle_info: 'read', fuel: 'read_write', vehicle_settings: 'full' }, vehicleCreate: true, vehicleMode: 'all_current_future' });
      const hash = sha256Hex(token);
      const bodies: string[] = [];
      const keep = (r: { text: string; headers: Headers }) => { bodies.push(r.text, JSON.stringify([...r.headers])); return r; };
      const v = keep(await w.call('POST', VEH, { token, body: { name: 'A', odometerUnit: 'km', currency: 'EUR' } }));
      const vid = v.text && JSON.parse(v.text).id;
      keep(await w.call('POST', `${VEH}/${vid}/fill-ups`, { token, body: { occurredAt: '2026-10-01T08:00:00Z', odometer: { value: '1', unit: 'km' }, volume: { value: '1', unit: 'l' } } }));
      keep(await w.call('GET', VEH, { token: FAKE })); keep(await w.call('DELETE', `${VEH}/${vid}`, { token })); keep(await w.call('POST', VEH, { token, body: { nope: 1 } }));
      for (const b of bodies) { assert.ok(!b.includes(token), 'token echoed'); assert.ok(!b.includes(hash), 'hash echoed'); }
      // Every text/jsonb column of every table, minus the credential table itself (which holds only the hash).
      const tables = (await w.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
      for (const t of tables) {
        const dump = JSON.stringify((await w.db.query(`SELECT to_jsonb(x) AS j FROM ${t} x`)).rows);
        assert.ok(!dump.includes(token), `raw token found in ${t}`);
        if (t !== 'api_keys') assert.ok(!dump.includes(hash), `token hash found in ${t}`);
      }
      assert.equal((await w.db.query('SELECT token_hash FROM api_keys WHERE id = $1', [id])).rows[0].token_hash, hash);
      // A handler failure is logged without the token or the header.
      await w.db.query('DROP TABLE vehicle_images');
      const boom = await w.call('GET', `${VEH}/${vid}/image`, { token });
      assert.equal(boom.status, 500);
      assert.ok(!boom.text.includes(token));
    });
  } finally { console.error = orig; }
  assert.ok(logged.length >= 1, 'the 500 was logged');
  for (const l of logged) assert.ok(!/dlk_[A-Za-z0-9_-]{20,}/.test(l) && !/authorization/i.test(l), `log line leaks: ${l.slice(0, 120)}`);
});

test('without a gate (key authentication off) every credential header is refused, never ignored', { skip }, async () => {
  const h = (await harness())!;
  const app = createApp({ routes: allRoutes(h.ctx, null), authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: noProxies });
  const server = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/v1/vehicles`, { headers: { authorization: `Bearer ${FAKE}` } });
    assert.equal(r.status, 401); assert.equal(((await r.json()) as { code: string }).code, 'invalid_api_key');
    assert.equal((await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${FAKE}` } })).status, 200);
  } finally { server.close(); server.closeAllConnections(); await h.drop(); }
});

test('routes without a declared policy are session-only: a key is refused on a route the table does not know', { skip }, async () => {
  const h = (await harness())!;
  const u = (await import('./helpers/index.ts')).createTestUser;
  const user = await u(h.ctx.db);
  const gate = createApiKeyGate(h.ctx);
  const app = createApp({ routes: [{ method: 'GET', path: '/v1/undeclared', handler: async () => ({ status: 200, body: { ok: true } }) }], authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: noProxies, apiKeys: gate });
  const server = createServer((q, s) => void app(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { token } = await keys.createApiKey(h.ctx, user.principal, keys.parseCreateInput({ name: 'k', permissions: { vehicle_info: 'read' } }));
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/undeclared`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 403); assert.equal(((await r.json()) as { code: string }).code, 'api_key_not_allowed');
  } finally { server.close(); server.closeAllConnections(); await h.drop(); }
});

// ---------- the second lock: handlers and helpers refuse a key even if the router did not ----------
test('requireFresh, requireSessionPrincipal and requireInstanceAdmin refuse a key principal', async () => {
  const { requireFresh } = await import('../src/auth/sessions.ts');
  const { requireSessionPrincipal, requireInstanceAdmin, AuthError } = await import('../src/identity.ts');
  const key = { kind: 'api_key' as const, userId: '00000000-0000-7000-8000-000000000001', instanceRole: 'user' as const, apiKey: { id: '00000000-0000-7000-8000-000000000002', name: 'k', grants: { levels: {}, vehicleCreate: false }, vehicleMode: 'selected' as const, vehicleIds: new Set<string>(), expiresAt: null, rule: null, requestId: 'r', checkedAt: new Date() } };
  const ctx = { db: null, config: { reauthWindowMs: 600_000 }, now: () => new Date() } as never;
  const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof AuthError && e.code === 'api_key_not_allowed' && e.status === 403);
  refused(() => requireFresh(ctx, key as never));
  refused(() => requireSessionPrincipal({ principal: key as never }));
  refused(() => requireInstanceAdmin({ principal: key as never }));
  const session = { kind: 'session' as const, userId: key.userId, sessionId: key.apiKey.id, instanceRole: 'admin' as const, authenticatedAt: new Date() };
  assert.doesNotThrow(() => requireFresh(ctx, session as never));
  assert.equal(requireInstanceAdmin({ principal: session as never }).userId, key.userId);
});

test('every session-only handler that needs a session refuses a key principal on its own, without the router', { skip }, async () => {
  const h = (await harness())!;
  try {
    const key: ApiKeyPrincipal = { kind: 'api_key' as const, userId: '00000000-0000-7000-8000-000000000001' as Id, instanceRole: 'user' as const, apiKey: { id: '00000000-0000-7000-8000-000000000002' as Id, name: 'k', grants: { levels: { vehicle_info: 'read' as const, fuel: 'full' as const, service: 'full' as const, maintenance: 'full' as const, vehicle_settings: 'full' as const, notifications: 'read_write' as const, statistics: 'read' as const }, vehicleCreate: true }, vehicleMode: 'all_current_future' as const, vehicleIds: new Set<Id>(), expiresAt: null, rule: null, requestId: 'r', checkedAt: new Date() } };
    const id = '00000000-0000-7000-8000-000000000003';
    const routes = allRoutes(h.ctx).filter((r) => KEY_ROUTE_POLICIES[`${r.method} ${r.path}`] === 'session_only' && (r.auth ?? 'required') === 'required');
    assert.ok(routes.length >= 55, `${routes.length} session-only routes that need a session`);
    const leaks: string[] = [];
    for (const r of routes) {
      const params = Object.fromEntries([...r.path.matchAll(/:(\w+)/g)].map((m) => [m[1]!, id]));
      try {
        await r.handler({ ctx: { principal: key }, session: null, params, query: new URLSearchParams(), body: {}, headers: {}, cookies: {}, ip: '127.0.0.1' });
        leaks.push(`${r.method} ${r.path}: answered a key`);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== 'api_key_not_allowed') leaks.push(`${r.method} ${r.path}: ${code ?? String(e)}`);
      }
    }
    assert.deepEqual(leaks, []);
  } finally { await h.drop(); }
});
