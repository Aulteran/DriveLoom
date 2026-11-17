// Instance default units chosen at setup, inherited by every user until they
// choose their own, and per-user units chosen at registration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.ts';
import { authRoutes } from '../src/auth/routes.ts';
import { adminRoutes } from '../src/admin/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import * as oidc from '../src/auth/oidc.ts';
import { ORIGIN } from './helpers/index.ts';
import { harness, meta, PW, type Harness } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const ALL = ['distanceUnit', 'volumeUnit', 'economyUnit', 'currency'];
const IMPERIAL = { distanceUnit: 'mi', volumeUnit: 'gal_us', economyUnit: 'mpg_us', currency: 'USD' };

interface Client { (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> }

async function world(over: Parameters<typeof harness>[0], fn: (w: { h: Harness; anon: Client; signUp(email: string, extra?: Record<string, unknown>): Promise<Client> }) => Promise<void>) {
  const h = (await harness(over))!;
  const routes = [...authRoutes(h.ctx), ...adminRoutes(h.ctx), ...preferenceRoutes(h.ctx.db)];
  const server = createServer((q, s) => void createApp({ routes, authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (cookie = '', csrf = ''): Client => async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const anon = client();
  const signUp = async (email: string, extra: Record<string, unknown> = {}) => {
    const reg = await anon('POST', '/v1/auth/register', { email, password: PW, ...extra });
    assert.equal(reg.status, 202, JSON.stringify(reg.json));
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    return client(res.headers.getSetCookie()[0]!.split(';')[0]!, (await res.json() as { csrf_token: string }).csrf_token);
  };
  try { await fn({ h, anon, signUp }); } finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

test('setup units become the instance defaults that users inherit until they choose their own', { skip }, () => world({ registration: 'open' }, async ({ h, anon, signUp }) => {
  const bad = await anon('POST', '/v1/auth/register', { email: 'admin@example.test', password: PW, units: { distanceUnit: 'furlongs' } });
  assert.deepEqual([bad.status, bad.json.code], [422, 'validation_failed']);
  assert.equal((await h.ctx.db.query('SELECT 1 FROM users')).rowCount, 0, 'invalid units create nothing');

  const admin = await signUp('admin@example.test', { units: { distanceUnit: 'mi', volumeUnit: 'gal_us', economyUnit: 'mpg_us' } });
  assert.deepEqual((await anon('GET', '/v1/auth/instance')).json.default_units, IMPERIAL);
  assert.deepEqual((await admin('GET', '/v1/preferences')).json, { ...IMPERIAL, instanceDefaults: IMPERIAL, inherited: ALL }, 'the administrator follows the defaults too');

  // A new user who picks nothing inherits the defaults.
  const plain = await signUp('plain@example.test');
  assert.deepEqual((await plain('GET', '/v1/preferences')).json, { ...IMPERIAL, instanceDefaults: IMPERIAL, inherited: ALL });

  // A new user who picks some units keeps them; the rest follow the defaults.
  const picky = await signUp('picky@example.test', { units: { economyUnit: 'l_per_100km', currency: 'EUR' } });
  assert.deepEqual((await picky('GET', '/v1/preferences')).json,
    { ...IMPERIAL, economyUnit: 'l_per_100km', currency: 'EUR', instanceDefaults: IMPERIAL, inherited: ['distanceUnit', 'volumeUnit'] });

  // Later, the administrator changes the defaults: only inherited fields move.
  assert.equal((await plain('PUT', '/v1/admin/settings/units', { distanceUnit: 'km' })).status, 403);
  const metric = { distanceUnit: 'km', volumeUnit: 'l', economyUnit: 'l_per_100km', currency: 'CAD' };
  const changed = await admin('PUT', '/v1/admin/settings/units', metric);
  assert.deepEqual([changed.status, changed.json], [200, metric]);
  assert.equal((await admin('PUT', '/v1/admin/settings/units', { volumeUnit: 'barrels' })).status, 422);
  assert.deepEqual((await admin('GET', '/v1/admin/settings/units')).json, metric);
  assert.deepEqual((await plain('GET', '/v1/preferences')).json, { ...metric, instanceDefaults: metric, inherited: ALL });
  assert.deepEqual((await picky('GET', '/v1/preferences')).json, { ...metric, currency: 'EUR', instanceDefaults: metric, inherited: ['distanceUnit', 'volumeUnit'] });

  // A user's own choice sticks; null goes back to following the default.
  const own = await plain('PUT', '/v1/preferences', { distanceUnit: 'mi' });
  assert.deepEqual([own.json.distanceUnit, own.json.inherited], ['mi', ['volumeUnit', 'economyUnit', 'currency']]);
  const back = await plain('PUT', '/v1/preferences', { distanceUnit: null });
  assert.deepEqual([back.json.distanceUnit, back.json.inherited], ['km', ALL]);

  const audit = await h.ctx.db.query("SELECT details FROM audit_events WHERE action = 'admin.unit_defaults_changed'");
  assert.deepEqual(audit.rows.map((r) => r.details), [metric]);
}));

test('units chosen before signing up through the identity provider are applied to the new account', { skip }, async () => {
  const h = (await harness({ registration: 'open' }))!;
  try {
    const login = async (units?: unknown) => {
      const st = await oidc.start(h.ctx, { mode: 'login', principal: null, units }, meta);
      const r = await oidc.callback(h.ctx, { query: new URLSearchParams({ code: 'abc', state: new URL(st.url).searchParams.get('state')! }), binding: st.binding, principal: null }, meta);
      return r.kind === 'login' ? r.signIn.userId : null;
    };
    await assert.rejects(oidc.start(h.ctx, { mode: 'login', principal: null, units: { currency: 'ZZZ' } }, meta));
    const first = await login({ distanceUnit: 'mi', currency: 'GBP' });
    const defaults = await h.ctx.db.query('SELECT distance_unit, volume_unit, currency FROM instance_settings');
    assert.deepEqual(defaults.rows[0], { distance_unit: 'mi', volume_unit: 'l', currency: 'GBP' }, 'bootstrap via OIDC sets the defaults');
    assert.equal((await h.ctx.db.query('SELECT 1 FROM user_preferences WHERE user_id = $1', [first])).rowCount, 0);
    // An existing account signing in again does not touch its preferences.
    assert.equal(await login({ volumeUnit: 'gal_imp' }), first);
    assert.equal((await h.ctx.db.query('SELECT 1 FROM user_preferences')).rowCount, 0);
    h.oidc.claims = { ...h.oidc.claims, subject: 'someone-else', email: 'second@example.test' };
    const second = await login({ volumeUnit: 'gal_imp' });
    const own = await h.ctx.db.query('SELECT distance_unit, volume_unit FROM user_preferences WHERE user_id = $1', [second]);
    assert.deepEqual(own.rows[0], { distance_unit: null, volume_unit: 'gal_imp' });
  } finally { await h.drop(); }
});
