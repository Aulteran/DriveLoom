// API keys, phase 2: storage, lifecycle, session-only management endpoints, revocation hooks, admin switch, backup.
// Everything goes through the real router with real sessions, so CSRF, cookies and fresh-sign-in behave as in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { createApp } from '../src/http/app.ts';
import { authRoutes } from '../src/auth/routes.ts';
import { adminRoutes } from '../src/admin/routes.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import * as acct from '../src/auth/accounts.ts';
import * as keys from '../src/auth/api-keys.ts';
import { sha256Hex } from '../src/auth/crypto.ts';
import { BackupError, EPHEMERAL_TABLES, createBackup, restoreBackup, verifyBackup } from '../src/backup.ts';
import { uuidv7 } from '../src/ids.ts';
import { ORIGIN } from './helpers/index.ts';
import { harness, meta, PW, type Harness } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

interface Res { status: number; json: any; headers: Headers }
interface Client { (method: string, path: string, body?: unknown): Promise<Res>; id: string; email: string }
interface World {
  h: Harness; anon: Client; db: pg.Pool;
  signUp(email: string): Promise<Client>;
  /** Make every session's last sign-in older than the fresh-authentication window. */
  stale(): void;
  reauth(c: Client): Promise<void>;
}

async function world(fn: (w: World) => Promise<void>, over: Parameters<typeof harness>[0] = {}): Promise<void> {
  const h = (await harness(over))!;
  const routes = [...authRoutes(h.ctx), ...adminRoutes(h.ctx), ...vehicleRoutes(new VehicleService(h.ctx.db))];
  const server = createServer((q, s) => void createApp({ routes, authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (cookie = '', csrf = '', id = '', email = ''): Client => Object.assign(async (method: string, p: string, body?: unknown): Promise<Res> => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }, { id, email });
  const anon = client();
  const signUp = async (email: string) => {
    assert.equal((await anon('POST', '/v1/auth/register', { email, password: PW })).status, 202);
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const c = client(res.headers.getSetCookie()[0]!.split(';')[0]!, (await res.json() as { csrf_token: string }).csrf_token, '', email);
    c.id = (await c('GET', '/v1/auth/session')).json.account.id;
    return c;
  };
  const stale = () => { h.clock.t += h.ctx.config.reauthWindowMs + 1000; };
  const reauth = async (c: Client) => { assert.equal((await c('POST', '/v1/auth/reauth', { password: PW })).status, 204); };
  try { await fn({ h, anon, db: h.ctx.db, signUp, stale, reauth }); } finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

const KEYS = '/v1/auth/api-keys';
const TOKEN = /^dlk_[A-Za-z0-9_-]{43}$/;
const mkKey = async (c: Client, body: Record<string, unknown> = {}) => {
  const r = await c('POST', KEYS, { name: 'CLI', ...body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json as { id: string; token: string; [k: string]: any };
};
const mkVehicle = async (c: Client, name = 'Car') => {
  const r = await c('POST', '/v1/vehicles', { name, odometerUnit: 'km', currency: 'EUR' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id as string;
};
const problem = (r: Res) => r.json?.code as string;
const statusOf = async (db: pg.Pool, id: string) => (await db.query('SELECT revoked_at, expires_at FROM api_keys WHERE id = $1', [id])).rows[0];
const lookup = (h: Harness, token: string) => keys.lookupApiKey(h.ctx, token);
const reason = async (h: Harness, token: string) => { const r = await lookup(h, token); return r.ok ? 'ok' : r.reason; };

test('creation stores only a hash; the token is shown once and never appears anywhere else', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test');
  const v = await mkVehicle(a);
  const created = await a('POST', KEYS, { name: '  Importer  ', permissions: { service: 'read_write' }, vehicleIds: [v] });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const token: string = created.json.token;
  assert.match(token, TOKEN);
  assert.equal(token.length, 47);
  assert.equal(created.json.prefix, token.slice(0, 12));
  assert.equal(created.json.name, 'Importer', 'names are trimmed');
  const row = (await db.query('SELECT token_hash, token_prefix FROM api_keys')).rows[0];
  assert.equal(row.token_hash, sha256Hex(token));
  assert.equal(row.token_prefix, token.slice(0, 12));

  // Another key has another, equally long, secret.
  const second = await mkKey(a, { name: 'Other' });
  assert.notEqual(second.token, token);
  assert.equal(new Set([token, second.token].map((t) => t.slice(4))).size, 2);

  // Rotate, list, activity, the admin audit log: none of them carries a secret; neither does any table.
  const rotated = await a('POST', `${KEYS}/${second.id}/rotate`);
  assert.equal(rotated.status, 200);
  assert.equal(rotated.headers.get('cache-control'), 'no-store');
  const secrets = [token, second.token, rotated.json.token as string];
  const list = await a('GET', KEYS);
  const act = await a('GET', `${KEYS}/${second.id}/activity`);
  const dump = JSON.stringify([list.json, act.json]);
  for (const s of secrets) assert.ok(!dump.includes(s) && !dump.includes(s.slice(4)), 'list and activity never contain a token');
  assert.ok(!('token' in list.json.items[0]) && !('token_hash' in list.json.items[0]) && !('tokenHash' in list.json.items[0]));
  const tables = (await db.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")).rows.map((r) => r.relname as string);
  for (const t of tables) {
    const text = (await db.query(`SELECT x::text AS t FROM "${t}" x`)).rows.map((r) => r.t).join('\n');
    for (const s of secrets) assert.ok(!text.includes(s.slice(4)), `${t} must not hold any token`);
  }
  // The token is not accepted as a lookup by hash and the hash is not accepted as a token.
  assert.equal(await reason(h, row.token_hash), 'malformed');
  assert.equal(await reason(h, token), 'ok');
}));

test('create validates input strictly and applies the defaults', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test'), b = await signUp('b@example.test');
  const va = await mkVehicle(a), vb = await mkVehicle(b);
  const bad = async (body: unknown, what: string) => { const r = await a('POST', KEYS, body); assert.equal(r.status, 422, `${what}: ${JSON.stringify(r.json)}`); assert.equal(problem(r), 'validation_failed', what); };
  await bad({}, 'no name');
  await bad({ name: '' }, 'empty name');
  await bad({ name: '   ' }, 'blank name');
  await bad({ name: 'x'.repeat(61) }, 'long name');
  await bad({ name: 'a\u0000b' }, 'control characters');
  await bad({ name: 5 }, 'non-text name');
  await bad({ name: 'k', surprise: 1 }, 'unknown field');
  await bad({ name: 'k', expiresIn: '2d' }, 'unknown expiry');
  await bad({ name: 'k', permissions: { billing: 'read' } }, 'unknown module');
  await bad({ name: 'k', permissions: { __proto__: 'x', constructor: 'read' } }, 'prototype names');
  await bad({ name: 'k', permissions: { fuel: 'admin' } }, 'unknown level');
  await bad({ name: 'k', permissions: { fuel: 'FULL' } }, 'case matters');
  await bad({ name: 'k', permissions: { vehicle_info: 'read_write' } }, 'vehicle_info is read-only');
  await bad({ name: 'k', permissions: { vehicle_settings: 'read' } }, 'vehicle_settings has no read');
  await bad({ name: 'k', permissions: { notifications: 'full' } }, 'notifications has no delete');
  await bad({ name: 'k', permissions: { statistics: 'read_write' } }, 'statistics is read-only');
  await bad({ name: 'k', permissions: { vehicle_create: 'read' } }, 'vehicle creation is a boolean');
  await bad({ name: 'k', permissions: ['fuel'] }, 'permissions as a list');
  await bad({ name: 'k', vehicleCreate: 'yes' }, 'non-boolean vehicleCreate');
  await bad({ name: 'k', vehicleMode: 'everything' }, 'unknown mode');
  await bad({ name: 'k', vehicleIds: [vb] }, "another user's vehicle");
  await bad({ name: 'k', vehicleIds: [uuidv7()] }, 'unknown vehicle');
  await bad({ name: 'k', vehicleIds: ['nope'] }, 'not an id');
  await bad({ name: 'k', vehicleMode: 'all_current', vehicleIds: [va] }, 'ids with a non-selected mode');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 0, 'nothing was created by a rejected request');

  const now = h.ctx.now().getTime();
  const k = await mkKey(a, { name: 'Defaults' });
  assert.deepEqual([k.permissions, k.vehicleMode, k.vehicleIds, k.vehicleCreate, k.status], [{}, 'selected', [], false, 'active']);
  assert.equal(Date.parse(k.expiresAt), now + 30 * 86_400_000, 'default expiry is 30 days, computed by the server');
  for (const [opt, ms] of [['24h', 86_400_000], ['7d', 7 * 86_400_000], ['30d', 30 * 86_400_000], ['90d', 90 * 86_400_000], ['365d', 365 * 86_400_000]] as const) {
    assert.equal(Date.parse((await mkKey(a, { expiresIn: opt })).expiresAt), now + ms, opt);
  }
  assert.equal((await mkKey(a, { expiresIn: 'never' })).expiresAt, null);
  // Modes: selected keeps the explicit ids, all_current snapshots accessible vehicles, all_current_future stores none.
  const v2 = await mkVehicle(a, 'Second');
  assert.deepEqual((await mkKey(a, { vehicleIds: [va, va] })).vehicleIds, [va], 'duplicates collapse');
  assert.deepEqual([...(await mkKey(a, { vehicleMode: 'all_current' })).vehicleIds].sort(), [va, v2].sort());
  const future = await mkKey(a, { vehicleMode: 'all_current_future' });
  assert.deepEqual([future.vehicleMode, future.vehicleIds], ['all_current_future', []]);
  // The snapshot does not grow when a vehicle is added later.
  const snap = await mkKey(a, { vehicleMode: 'all_current', name: 'Snap' });
  const v3 = await mkVehicle(a, 'Third');
  const listed = (await a('GET', KEYS)).json.items.find((i: any) => i.id === snap.id);
  assert.ok(!listed.vehicleIds.includes(v3));
  // Level modules and the boolean.
  const full = await mkKey(a, { permissions: { vehicle_info: 'read', vehicle_settings: 'full', fuel: 'none', service: 'read_write', maintenance: 'full', notifications: 'read_write', statistics: 'read' }, vehicleCreate: true });
  assert.deepEqual(full.permissions, { vehicle_info: 'read', vehicle_settings: 'full', service: 'read_write', maintenance: 'full', notifications: 'read_write', statistics: 'read' }, 'none is not stored');
  assert.equal(full.vehicleCreate, true);
}));

test('concurrent creates never exceed 25 active keys; expired and revoked keys do not count', { skip }, () => world(async ({ h, db, signUp, reauth, stale }) => {
  const a = await signUp('a@example.test');
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => a('POST', KEYS, { name: `k${i}`, expiresIn: '24h' })));
  assert.equal(results.filter((r) => r.status === 201).length, 25);
  const refused = results.filter((r) => r.status !== 201);
  assert.equal(refused.length, 5);
  assert.ok(refused.every((r) => r.status === 409 && problem(r) === 'too_many_api_keys'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 25);
  assert.equal((await db.query('SELECT count(DISTINCT token_hash)::int AS n FROM api_keys')).rows[0].n, 25);

  // Revoking one frees a slot.
  const ids = (await a('GET', KEYS)).json.items.map((i: any) => i.id);
  assert.equal((await a('DELETE', `${KEYS}/${ids[0]}`)).status, 204);
  assert.equal((await a('POST', KEYS, { name: 'after revoke' })).status, 201);
  assert.equal((await a('POST', KEYS, { name: 'one too many' })).status, 409);
  // Expired keys free their slots too (24 of the 25 expire; the newest, 30 days, does not).
  h.clock.t += 2 * 86_400_000; stale(); await reauth(a);
  assert.equal((await a('POST', KEYS, { name: 'after expiry' })).status, 201);
  const list = (await a('GET', KEYS)).json;
  assert.equal(list.items.filter((i: any) => i.status === 'expired').length, 24, 'expired keys stay listed, as expired');
  assert.equal(list.items.filter((i: any) => i.status === 'revoked').length, 1);
  assert.equal(list.items.filter((i: any) => i.status === 'active').length, 2);
  assert.equal(list.maxActiveKeys, 25);
}));

test('fresh sign-in matrix: create, rotate and any broadening need it; rename, reduction and revoke do not', { skip }, () => world(async ({ h, signUp, stale, reauth, db }) => {
  const a = await signUp('a@example.test');
  const v1 = await mkVehicle(a, 'One'), v2 = await mkVehicle(a, 'Two');
  const mk = (name: string) => mkKey(a, { name, permissions: { fuel: 'read_write', service: 'read' }, vehicleIds: [v1], expiresIn: '7d' });
  const k = await mk('Matrix');
  stale();
  const patch = (id: string, body: unknown) => a('PATCH', `${KEYS}/${id}`, body);
  const code = (r: Res) => `${r.status} ${problem(r)}`;

  assert.equal(code(await a('POST', KEYS, { name: 'stale create' })), '403 reauth_required', 'create');
  assert.equal(code(await a('POST', `${KEYS}/${k.id}/rotate`)), '403 reauth_required', 'rotate');
  const broadening: [string, unknown][] = [
    ['higher level', { permissions: { fuel: 'full', service: 'read' } }],
    ['new module', { permissions: { fuel: 'read_write', service: 'read', maintenance: 'read' } }],
    ['read to read_write', { permissions: { fuel: 'read_write', service: 'read_write' } }],
    ['new vehicle', { vehicleIds: [v1, v2] }],
    ['different vehicle', { vehicleIds: [v2] }],
    ['all_current', { vehicleMode: 'all_current' }],
    ['all_current_future', { vehicleMode: 'all_current_future' }],
    ['vehicle creation', { vehicleCreate: true }],
    ['later expiry', { expiresIn: '90d' }],
    ['no expiry', { expiresIn: 'never' }],
  ];
  for (const [what, body] of broadening) assert.equal(code(await patch(k.id, body)), '403 reauth_required', what);
  const unchanged = (await a('GET', KEYS)).json.items.find((i: any) => i.id === k.id);
  assert.deepEqual([unchanged.permissions, unchanged.vehicleIds, unchanged.vehicleCreate, unchanged.expiresAt], [k.permissions, k.vehicleIds, false, k.expiresAt], 'a refused edit changes nothing');

  // Not broadening: rename, lower levels, fewer vehicles, earlier expiry, restating what is already there.
  assert.equal(code(await patch(k.id, { name: 'Renamed' })), '200 undefined');
  assert.equal(code(await patch(k.id, { permissions: { fuel: 'read', service: 'read' } })), '200 undefined', 'reduction');
  assert.equal(code(await patch(k.id, { permissions: { fuel: 'read' } })), '200 undefined', 'dropping a module');
  assert.equal(code(await patch(k.id, { vehicleIds: [] })), '200 undefined', 'fewer vehicles');
  assert.equal(code(await patch(k.id, { expiresIn: '24h' })), '200 undefined', 'earlier expiry');
  assert.equal(code(await patch(k.id, { vehicleMode: 'selected', vehicleIds: [], permissions: { fuel: 'read' }, name: 'Renamed' })), '200 undefined', 'same state');
  assert.equal(code(await patch(k.id, {})), '200 undefined', 'empty patch');
  assert.equal(code(await a('POST', `${KEYS}/revoke-all`)), '200 undefined', 'revoke-all needs no fresh sign-in');
  const k2 = await (async () => { await reauth(a); return mk('Second'); })();
  stale();
  assert.equal(code(await a('DELETE', `${KEYS}/${k2.id}`)), '204 undefined', 'revoke needs no fresh sign-in');

  // With a fresh sign-in every one of them works.
  await reauth(a);
  const k3 = await mk('Third');
  for (const [what, body] of broadening) assert.equal((await patch(k3.id, body)).status, 200, what);
  assert.equal((await a('POST', `${KEYS}/${k3.id}/rotate`)).status, 200);
  // Moving from all_current_future to a fixed set, or all_current to selected inside the snapshot, is a reduction.
  stale();
  assert.equal((await patch(k3.id, { vehicleMode: 'selected', vehicleIds: [v1] })).status, 200, 'future -> selected');
  await reauth(a);
  assert.equal((await patch(k3.id, { vehicleMode: 'all_current' })).status, 200);
  stale();
  assert.equal((await patch(k3.id, { vehicleMode: 'selected' })).status, 200, 'snapshot -> selected keeps the snapshot');
  assert.equal((await patch(k3.id, { vehicleMode: 'selected', vehicleIds: [v2] })).status, 200, 'a subset of the snapshot');
  void h; void db;
}));

test('edit validation: unknown names, inaccessible vehicles and selected-without-ids are 422', { skip }, () => world(async ({ signUp }) => {
  const a = await signUp('a@example.test'), b = await signUp('b@example.test');
  const va = await mkVehicle(a), vb = await mkVehicle(b);
  const k = await mkKey(a, { vehicleMode: 'all_current_future' });
  const bad = async (body: unknown) => { const r = await a('PATCH', `${KEYS}/${k.id}`, body); assert.equal(r.status, 422, JSON.stringify(body)); };
  await bad({ permissions: { nope: 'read' } });
  await bad({ permissions: { fuel: 'read_write', vehicle_info: 'full' } });
  await bad({ vehicleMode: 'selected' });
  await bad({ vehicleMode: 'selected', vehicleIds: [vb] });
  await bad({ vehicleIds: [va] });
  await bad({ name: '' });
  await bad({ vehicleMode: 'all_current', vehicleIds: [va] });
  await bad({ id: k.id });
}));

test("another user's keys look exactly like missing keys (404), for every operation", { skip }, () => world(async ({ signUp }) => {
  const a = await signUp('a@example.test'), b = await signUp('b@example.test');
  const k = await mkKey(a);
  const missing = uuidv7();
  const same = async (method: string, suffix: string, body?: unknown) => {
    const theirs = await b(method, `${KEYS}/${k.id}${suffix}`, body), none = await b(method, `${KEYS}/${missing}${suffix}`, body);
    assert.equal(theirs.status, 404, `${method} ${suffix}`);
    assert.deepEqual(theirs.json, none.json, `${method} ${suffix} must not reveal that the key exists`);
    assert.equal(problem(theirs), 'api_key_not_found');
  };
  await same('PATCH', '', { name: 'stolen' });
  await same('DELETE', '');
  await same('POST', '/rotate');
  await same('GET', '/activity');
  assert.equal((await b('PATCH', `${KEYS}/not-an-id`, { name: 'x' })).status, 404);
  assert.deepEqual((await b('GET', KEYS)).json.items, []);
  assert.equal((await b('POST', `${KEYS}/revoke-all`)).json.revoked, 0, "revoke-all only touches the caller's keys");
  assert.equal((await a('GET', KEYS)).json.items[0].status, 'active');
  assert.equal((await a('GET', KEYS)).json.items[0].name, 'CLI');
}));

test('management is session-only: no credentials, no CSRF token, wrong method', { skip }, () => world(async ({ anon, signUp }) => {
  const a = await signUp('a@example.test');
  const k = await mkKey(a);
  for (const [m, p] of [['GET', KEYS], ['POST', KEYS], ['POST', `${KEYS}/revoke-all`], ['PATCH', `${KEYS}/${k.id}`], ['DELETE', `${KEYS}/${k.id}`], ['POST', `${KEYS}/${k.id}/rotate`], ['GET', `${KEYS}/${k.id}/activity`]] as const) {
    assert.equal((await anon(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  // `revoke-all` is a route of its own: it is neither a key id nor swallowed by one.
  assert.equal((await a('POST', `${KEYS}/revoke-all`)).status, 200);
  assert.equal((await a('GET', `${KEYS}/revoke-all`)).status, 405);
}));

test('csrf is required on every mutation', { skip }, async () => {
  const h = (await harness())!;
  const routes = authRoutes(h.ctx);
  const server = createServer((q, s) => void createApp({ routes, authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta);
    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', password: PW }) });
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const id = uuidv7();
    for (const [m, p] of [['POST', KEYS], ['POST', `${KEYS}/revoke-all`], ['PATCH', `${KEYS}/${id}`], ['DELETE', `${KEYS}/${id}`], ['POST', `${KEYS}/${id}/rotate`]] as const) {
      const r = await fetch(base + p, { method: m, headers: { cookie, 'content-type': 'application/json' }, body: m === 'DELETE' ? undefined : '{}' });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal((await r.json() as { code: string }).code, 'csrf_failed');
    }
  } finally { server.close(); server.closeAllConnections(); await h.drop(); }
});

test('expired and revoked keys can never be edited, rotated or reactivated', { skip }, () => world(async ({ h, db, signUp, reauth, stale }) => {
  const a = await signUp('a@example.test');
  const revoked = await mkKey(a, { name: 'Revoked' }), expiring = await mkKey(a, { name: 'Expiring', expiresIn: '24h' });
  assert.equal((await a('DELETE', `${KEYS}/${revoked.id}`)).status, 204);
  h.clock.t += 2 * 86_400_000; stale(); await reauth(a);
  for (const k of [revoked, expiring]) {
    const code = async (r: Promise<Res>) => { const x = await r; return `${x.status} ${problem(x)}`; };
    assert.equal(await code(a('PATCH', `${KEYS}/${k.id}`, { expiresIn: 'never' })), '409 api_key_not_active');
    assert.equal(await code(a('PATCH', `${KEYS}/${k.id}`, { name: 'Back from the dead' })), '409 api_key_not_active');
    assert.equal(await code(a('POST', `${KEYS}/${k.id}/rotate`)), '409 api_key_not_active');
  }
  const rows = (await a('GET', KEYS)).json.items;
  assert.deepEqual(rows.map((i: any) => i.status).sort(), ['expired', 'revoked']);
  assert.ok(rows.every((i: any) => i.name !== 'Back from the dead'));
  assert.equal(await reason(h, revoked.token), 'revoked');
  assert.equal(await reason(h, expiring.token), 'expired');
  assert.equal((await statusOf(db, revoked.id)).revoked_at !== null, true);
  // Expired and revoked keys may be removed from the list; their history stays.
  assert.equal((await a('DELETE', `${KEYS}/${expiring.id}`)).status, 204);
  assert.equal((await a('DELETE', `${KEYS}/${revoked.id}`)).status, 204);
  assert.deepEqual((await a('GET', KEYS)).json.items, []);
  const acts = (await a('GET', `${KEYS}/${revoked.id}/activity`)).json.items.map((i: any) => i.action);
  assert.deepEqual(acts, ['removed', 'revoked', 'created'], 'history of a removed key is still readable by its owner');
  assert.equal((await a('PATCH', `${KEYS}/${revoked.id}`, { name: 'x' })).status, 404, 'but the key itself is gone');
}));

test('rotation replaces the secret atomically and keeps id, grants and expiry; the old token dies at once', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test');
  const v = await mkVehicle(a);
  const k = await mkKey(a, { name: 'Rot', permissions: { service: 'read_write' }, vehicleIds: [v], expiresIn: '90d' });
  assert.equal(await reason(h, k.token), 'ok');
  h.clock.t += 5_000;
  const r = await a('POST', `${KEYS}/${k.id}/rotate`);
  assert.equal(r.status, 200);
  assert.match(r.json.token, TOKEN);
  assert.notEqual(r.json.token, k.token);
  assert.notEqual(r.json.prefix, k.prefix);
  assert.deepEqual([r.json.id, r.json.permissions, r.json.vehicleIds, r.json.expiresAt, r.json.vehicleMode], [k.id, k.permissions, k.vehicleIds, k.expiresAt, 'selected']);
  assert.ok(r.json.rotatedAt);
  assert.equal(await reason(h, k.token), 'unknown', 'no grace period');
  const ok = await lookup(h, r.json.token);
  assert.ok(ok.ok && ok.key.id === k.id && ok.key.credentialVersion === 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 1);
  assert.equal((await db.query('SELECT token_hash FROM api_keys')).rows[0].token_hash, sha256Hex(r.json.token));
  assert.deepEqual((await a('GET', `${KEYS}/${k.id}/activity`)).json.items.map((i: any) => i.action), ['rotated', 'created']);
}));

test('lookup resolves grants and scope, and rejects everything that must not authenticate', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test'), admin = a;
  const v = await mkVehicle(a);
  const k = await mkKey(a, { permissions: { fuel: 'full', service: 'read', notifications: 'read_write' }, vehicleCreate: true, vehicleIds: [v] });
  const r = await lookup(h, k.token);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.key.grants, { levels: { fuel: 'full', service: 'read', notifications: 'read_write' }, vehicleCreate: true });
  assert.deepEqual([r.key.userId, r.key.name, r.key.vehicleMode, [...r.key.vehicleIds], r.key.instanceRole], [a.id, 'CLI', 'selected', [v], 'admin']);
  assert.equal((await keys.lookupApiKey(h.ctx, 'dlk_short')).ok, false);
  assert.equal(await reason(h, `dlk_${'A'.repeat(43)}`), 'unknown');
  assert.equal(await reason(h, `Bearer ${k.token}`), 'malformed');
  assert.equal(await reason(h, `${k.token}x`), 'malformed');
  // Unknown grants in the database fail closed.
  await db.query('ALTER TABLE api_key_permissions DROP CONSTRAINT api_key_permissions_module, DROP CONSTRAINT api_key_permissions_supported');
  await db.query("INSERT INTO api_key_permissions (key_id, module, level) VALUES ($1, 'billing', 'full')", [k.id]);
  assert.deepEqual(((await lookup(h, k.token)) as any).key.grants.levels, { fuel: 'full', service: 'read', notifications: 'read_write' });
  await db.query("DELETE FROM api_key_permissions WHERE module = 'billing'");
  // last_used_at is written at most once a minute.
  assert.equal(await keys.touchApiKeyUsed(h.ctx, k.id as never), true);
  assert.equal(await keys.touchApiKeyUsed(h.ctx, k.id as never), false);
  h.clock.t += 30_000;
  assert.equal(await keys.touchApiKeyUsed(h.ctx, k.id as never), false);
  h.clock.t += 31_000;
  assert.equal(await keys.touchApiKeyUsed(h.ctx, k.id as never), true);
  assert.ok((await a('GET', KEYS)).json.items[0].lastUsedAt);
  // A disabled owner and a disabled instance reject the key; a revoked key stays revoked.
  await db.query("UPDATE users SET status = 'disabled' WHERE id = $1", [a.id]);
  assert.equal(await reason(h, k.token), 'user_inactive');
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [a.id]);
  assert.equal(await reason(h, k.token), 'ok');
  assert.equal((await admin('PUT', '/v1/admin/settings/api-keys', { enabled: false })).status, 200);
  assert.equal(await reason(h, k.token), 'instance_disabled');
  assert.equal((await admin('PUT', '/v1/admin/settings/api-keys', { enabled: true })).status, 200);
  assert.equal(await reason(h, k.token), 'ok');
  await a('DELETE', `${KEYS}/${k.id}`);
  assert.equal(await reason(h, k.token), 'revoked');
}));

test('revoke-all is a lockdown: every active key, no fresh sign-in, history kept', { skip }, () => world(async ({ h, db, signUp, stale }) => {
  const a = await signUp('a@example.test'), b = await signUp('b@example.test');
  const mine = [await mkKey(a, { name: 'one' }), await mkKey(a, { name: 'two', expiresIn: 'never' }), await mkKey(a, { name: 'three' })];
  const theirs = await mkKey(b);
  assert.equal((await a('DELETE', `${KEYS}/${mine[2]!.id}`)).status, 204);
  stale();
  const r = await a('POST', `${KEYS}/revoke-all`);
  assert.deepEqual([r.status, r.json], [200, { revoked: 2 }], 'only the two that were still active');
  for (const k of mine) assert.equal(await reason(h, k.token), 'revoked');
  assert.equal(await reason(h, theirs.token), 'ok', "other users' keys are untouched");
  assert.deepEqual((await a('GET', KEYS)).json.items.map((i: any) => i.status), ['revoked', 'revoked', 'revoked']);
  assert.deepEqual((await a('GET', `${KEYS}/${mine[0]!.id}/activity`)).json.items.map((i: any) => i.action), ['revoked_all', 'created']);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'api_keys.revoked_all'")).rows[0].n, 1);
  assert.equal((await a('POST', `${KEYS}/revoke-all`)).json.revoked, 0, 'idempotent');
}));

test('activity: key-management events, owner-only pagination, vehicle redaction after membership loss', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test'), b = await signUp('b@example.test');
  const v = await mkVehicle(a);
  const k = await mkKey(a, { name: 'Hist', vehicleIds: [v] });
  assert.equal((await a('PATCH', `${KEYS}/${k.id}`, { name: 'Hist 2' })).status, 200);
  assert.equal((await a('POST', `${KEYS}/${k.id}/rotate`)).status, 200);
  assert.equal((await a('DELETE', `${KEYS}/${k.id}`)).status, 204);
  const all = (await a('GET', `${KEYS}/${k.id}/activity`)).json;
  assert.deepEqual(all.items.map((i: any) => i.action), ['revoked', 'rotated', 'updated', 'created']);
  assert.deepEqual([all.items[2].keyName, all.items[3].keyName], ['Hist 2', 'Hist'], 'each row snapshots the name at the time');
  assert.equal(all.nextBefore, null);
  assert.deepEqual(all.items[2].metadata, { changed: ['name'], broadened: false, previousName: 'Hist' });
  assert.ok(all.items.every((i: any) => i.targetType === 'api_key' && i.targetIds[0] === k.id && !i.redacted));
  // Pagination.
  const p1 = (await a('GET', `${KEYS}/${k.id}/activity?limit=3`)).json;
  assert.equal(p1.items.length, 3);
  assert.ok(p1.nextBefore);
  const p2 = (await a('GET', `${KEYS}/${k.id}/activity?limit=3&before=${p1.nextBefore}`)).json;
  assert.deepEqual([p2.items.length, p2.nextBefore], [1, null]);
  assert.deepEqual([...p1.items, ...p2.items].map((i: any) => i.id), all.items.map((i: any) => i.id));
  for (const q of ['limit=0', 'limit=201', 'limit=x', 'before=nope']) assert.equal((await a('GET', `${KEYS}/${k.id}/activity?${q}`)).status, 422, q);
  assert.equal((await b('GET', `${KEYS}/${k.id}/activity`)).status, 404, 'owner only, even after revocation');

  // A write made with the key (recorded by a later phase through recordKeyActivity) about a vehicle the owner then loses is redacted.
  await keys.recordKeyActivity(db, { keyId: k.id as never, userId: a.id as never, keyName: 'Hist 2', action: 'service_visit.created', targetType: 'service_visit', targetIds: [uuidv7() as never], vehicleId: v as never, metadata: { items: 2 }, at: h.ctx.now() });
  const seen = (await a('GET', `${KEYS}/${k.id}/activity?limit=1`)).json.items[0];
  assert.deepEqual([seen.action, seen.vehicleId, seen.redacted, seen.metadata], ['service_visit.created', v, false, { items: 2 }]);
  await db.query('DELETE FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [v, a.id]);
  const hidden = (await a('GET', `${KEYS}/${k.id}/activity?limit=1`)).json.items[0];
  assert.deepEqual([hidden.action, hidden.vehicleId, hidden.targetIds, hidden.redacted, hidden.metadata], ['service_visit.created', null, [], true, {}]);
}));

test('the admin switch: default on; off blocks create, rotate and broadening, but not list, activity, revoke or reductions', { skip }, () => world(async ({ h, db, signUp }) => {
  const admin = await signUp('admin@example.test'), user = await signUp('user@example.test');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM instance_flags')).rows[0].n, 0, 'no row: enabled');
  assert.deepEqual((await admin('GET', '/v1/admin/settings/api-keys')).json, { enabled: true });
  assert.equal((await user('GET', '/v1/admin/settings/api-keys')).status, 403);
  assert.equal((await user('PUT', '/v1/admin/settings/api-keys', { enabled: false })).status, 403);
  assert.equal((await admin('PUT', '/v1/admin/settings/api-keys', { enabled: 'no' })).status, 422);
  assert.equal((await admin('PUT', '/v1/admin/settings/api-keys', { enabled: false, extra: 1 })).status, 422);

  const v = await mkVehicle(user);
  const k = await mkKey(user, { name: 'On', permissions: { fuel: 'full', service: 'read' }, vehicleIds: [v], expiresIn: '90d' });
  const other = await mkKey(user, { name: 'Other' });
  assert.deepEqual((await admin('PUT', '/v1/admin/settings/api-keys', { enabled: false })).json, { enabled: false });
  assert.equal(await reason(h, k.token), 'instance_disabled');

  const code = (r: Res) => `${r.status} ${problem(r)}`;
  assert.equal(code(await user('POST', KEYS, { name: 'new' })), '403 api_keys_disabled');
  assert.equal(code(await user('POST', `${KEYS}/${k.id}/rotate`)), '403 api_keys_disabled');
  for (const body of [{ permissions: { fuel: 'full', service: 'full' } }, { vehicleCreate: true }, { expiresIn: 'never' }, { vehicleMode: 'all_current_future' }]) {
    assert.equal(code(await user('PATCH', `${KEYS}/${k.id}`, body)), '403 api_keys_disabled', JSON.stringify(body));
  }
  const list = await user('GET', KEYS);
  assert.deepEqual([list.status, list.json.apiKeysEnabled, list.json.items.length], [200, false, 2]);
  assert.equal((await user('GET', `${KEYS}/${k.id}/activity`)).status, 200);
  assert.equal((await user('PATCH', `${KEYS}/${k.id}`, { name: 'Renamed', permissions: { fuel: 'read' }, expiresIn: '24h' })).status, 200, 'rename and reductions still work');
  assert.equal((await user('DELETE', `${KEYS}/${other.id}`)).status, 204, 'revoke works');
  assert.equal((await user('POST', `${KEYS}/revoke-all`)).status, 200, 'lockdown works');

  // Turning it back on resumes only keys that are still valid.
  assert.deepEqual((await admin('PUT', '/v1/admin/settings/api-keys', { enabled: true })).json, { enabled: true });
  assert.equal(await reason(h, k.token), 'revoked');
  const fresh = await mkKey(user, { name: 'Again' });
  assert.equal(await reason(h, fresh.token), 'ok');
  const audit = (await db.query("SELECT actor_id, details FROM audit_events WHERE action = 'admin.api_keys_changed' ORDER BY id")).rows;
  assert.deepEqual(audit.map((r) => r.details), [{ from: true, to: false }, { from: false, to: true }]);
  assert.ok(audit.every((r) => r.actor_id === admin.id));
}));

// ---------- revocation hooks ----------
const keyStates = async (db: pg.Pool, userId: string) => (await db.query('SELECT name, revoked_at IS NOT NULL AS revoked, revoked_reason FROM api_keys WHERE user_id = $1 ORDER BY name', [userId])).rows;
const failOn = async (db: pg.Pool, action: string) => {
  await db.query("CREATE OR REPLACE FUNCTION dl_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql");
  await db.query(`CREATE TRIGGER dl_boom BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = '${action}') EXECUTE FUNCTION dl_boom()`);
};
const healed = (db: pg.Pool) => db.query('DROP TRIGGER IF EXISTS dl_boom ON audit_events');

test('account recovery revokes every key in the same transaction; a failure rolls everything back', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test');
  const k = await mkKey(a, { name: 'r' });
  await mkKey(a, { name: 's', expiresIn: '24h' });
  const sessionCookieStillWorks = async () => (await a('GET', '/v1/auth/session')).status === 200;
  await (await acct.recoveryRequest(h.ctx, { email: 'a@example.test' }, meta)).delivery;
  await failOn(db, 'recovery.completed');
  const c1 = h.mailer.lastCode('a@example.test')!;
  await assert.rejects(acct.recoveryComplete(h.ctx, { email: 'a@example.test', code: c1, newPassword: 'a brand new passphrase' }, meta), /injected failure/);
  assert.deepEqual((await keyStates(db, a.id)).map((r) => r.revoked), [false, false], 'keys survive a failed recovery');
  assert.ok(await sessionCookieStillWorks(), 'and so do sessions');
  assert.equal(await reason(h, k.token), 'ok');
  assert.equal((await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta)).userId, a.id, 'the old password still works');
  await healed(db);

  await (await acct.recoveryRequest(h.ctx, { email: 'a@example.test' }, meta)).delivery;
  const c2 = h.mailer.lastCode('a@example.test')!;
  await acct.recoveryComplete(h.ctx, { email: 'a@example.test', code: c2, newPassword: 'a brand new passphrase' }, meta);
  assert.deepEqual((await keyStates(db, a.id)).map((r) => [r.revoked, r.revoked_reason]), [[true, 'account_recovery'], [true, 'account_recovery']]);
  assert.equal(await reason(h, k.token), 'revoked');
  assert.equal((await a('GET', '/v1/auth/session')).status, 401, 'sessions end with it');
  const recorded = (await db.query("SELECT details FROM audit_events WHERE action = 'api_keys.revoked_all'")).rows.map((r) => r.details);
  assert.deepEqual(recorded, [{ reason: 'account_recovery', count: 2 }]);
}));

test('operator password reset revokes every key atomically', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test');
  const k = await mkKey(a);
  await failOn(db, 'recovery.operator_password_reset');
  await assert.rejects(acct.adminResetPassword(h.ctx, 'a@example.test', 'operator chosen passphrase'), /injected failure/);
  assert.equal(await reason(h, k.token), 'ok');
  assert.equal((await a('GET', '/v1/auth/session')).status, 200);
  await healed(db);
  await acct.adminResetPassword(h.ctx, 'a@example.test', 'operator chosen passphrase');
  assert.equal(await reason(h, k.token), 'revoked');
  assert.equal((await keyStates(db, a.id))[0]!.revoked_reason, 'operator_recovery');
  assert.equal((await a('GET', '/v1/auth/session')).status, 401);
}));

test('disabling an account revokes its keys with the status change; re-enabling reactivates nothing', { skip }, () => world(async ({ h, db, signUp }) => {
  const admin = await signUp('admin@example.test'), user = await signUp('user@example.test'), bystander = await signUp('bystander@example.test');
  const k = await mkKey(user, { name: 'u' }), keep = await mkKey(bystander, { name: 'b' });
  await failOn(db, 'api_keys.revoked_all');
  const failed = await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'disabled' });
  assert.equal(failed.status, 500);
  assert.equal((await db.query('SELECT status FROM users WHERE id = $1', [user.id])).rows[0].status, 'active', 'the status change rolled back');
  assert.equal(await reason(h, k.token), 'ok');
  assert.equal((await user('GET', '/v1/auth/session')).status, 200, 'sessions too');
  await healed(db);

  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'disabled' })).status, 204);
  assert.equal((await keyStates(db, user.id))[0]!.revoked_reason, 'account_disabled');
  assert.equal(await reason(h, k.token), 'user_inactive');
  assert.equal(await reason(h, keep.token), 'ok', 'other accounts are untouched');
  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'active' })).status, 204);
  assert.equal(await reason(h, k.token), 'revoked', 're-enabling never reactivates a key');
  const relist = await acct.login(h.ctx, { email: 'user@example.test', password: PW }, meta);
  assert.equal((await keys.listApiKeys(h.ctx, relist.userId)).items[0]!.status, 'revoked');
}));

test('deleting the account removes its keys and strips the free text from their history, atomically', { skip }, () => world(async ({ h, db, signUp, stale, reauth }) => {
  await signUp('admin@example.test'); // the first account is the administrator, who cannot delete themselves while last
  const a = await signUp('a@example.test');
  const k = await mkKey(a, { name: 'Private name' });
  stale(); await reauth(a);
  await failOn(db, 'account.deleted');
  assert.equal((await a('DELETE', '/v1/auth/account')).status, 500);
  assert.equal(await reason(h, k.token), 'ok', 'rolled back with the deletion');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 1);
  await healed(db);
  assert.equal((await a('DELETE', '/v1/auth/account')).status, 204);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_key_permissions')).rows[0].n, 0);
  assert.equal(await reason(h, k.token), 'unknown');
  const left = (await db.query('SELECT key_id, user_id, key_name, action, metadata, request_id FROM api_key_activity ORDER BY id')).rows;
  assert.ok(left.length > 0 && left.every((r) => r.key_id === k.id && r.user_id === a.id && r.key_name === '' && Object.keys(r.metadata).length === 0 && r.request_id === null));
  assert.ok(!JSON.stringify(left).includes('Private name'));
}));

test('routine account events keep keys: password change, sign-out, sign-out everywhere, second factor, passkey and sign-in changes', { skip }, () => world(async ({ h, db, signUp }) => {
  const a = await signUp('a@example.test');
  const k = await mkKey(a);
  const still = async (what: string) => { assert.equal(await reason(h, k.token), 'ok', what); assert.deepEqual((await keyStates(db, a.id)).map((r) => r.revoked), [false], what); };
  assert.equal((await a('PUT', '/v1/auth/password', { current_password: PW, new_password: 'a brand new passphrase' })).status, 204);
  assert.equal((await a('GET', '/v1/auth/session')).status, 200, 'the current session survives a password change');
  await still('password change');
  const other = await acct.login(h.ctx, { email: 'a@example.test', password: 'a brand new passphrase' }, meta);
  assert.equal((await a('POST', '/v1/auth/sessions/revoke-others')).json.revoked, 1);
  assert.equal(await h.auth.resolveSession(other.session.token), null);
  await still('sign out everywhere');
  const totp = await a('POST', '/v1/auth/totp');
  assert.equal(totp.status, 200);
  await still('starting authenticator enrolment');
  await acct.login(h.ctx, { email: 'a@example.test', password: 'a brand new passphrase' }, meta);
  assert.equal((await a('POST', '/v1/auth/logout')).status, 204);
  await still('sign out');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'api_keys.revoked_all'")).rows[0].n, 0);
}));

// ---------- schema and backup ----------
test('database constraints reject malformed keys even if the application did not', { skip }, () => world(async ({ db, signUp }) => {
  const a = await signUp('a@example.test');
  const k = await mkKey(a);
  const ins = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = { id: uuidv7(), user_id: a.id, name: 'ok', token_hash: sha256Hex(uuidv7()), token_prefix: 'dlk_abcdefgh', vehicle_mode: 'selected', ...over };
    const cols = Object.keys(row);
    return db.query(`INSERT INTO api_keys (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  await ins({});
  await assert.rejects(ins({ name: '' }), /api_keys_name_check/);
  await assert.rejects(ins({ name: 'x'.repeat(61) }), /api_keys_name_check/);
  await assert.rejects(ins({ name: ' padded ' }), /api_keys_name_check/);
  await assert.rejects(ins({ vehicle_mode: 'everything' }), /vehicle_mode/);
  await assert.rejects(ins({ token_hash: 'plaintext-token' }), /token_hash/);
  await assert.rejects(ins({ token_hash: (await db.query('SELECT token_hash FROM api_keys LIMIT 1')).rows[0].token_hash }), /unique|duplicate/);
  await assert.rejects(ins({ token_prefix: 'dlk_' }), /token_prefix/);
  await assert.rejects(ins({ revoked_at: new Date() }), /revoked_reason/);
  const perm = (module: string, level: string) => db.query('INSERT INTO api_key_permissions (key_id, module, level) VALUES ($1,$2,$3)', [k.id, module, level]);
  await perm('fuel', 'full');
  await assert.rejects(perm('fuel', 'read'), /duplicate|pkey/);
  await assert.rejects(perm('billing', 'read'), /api_key_permissions_module/);
  await assert.rejects(perm('service', 'admin'), /api_key_permissions_level/);
  await assert.rejects(perm('service', 'none'), /api_key_permissions_level/);
  await assert.rejects(perm('vehicle_info', 'read_write'), /api_key_permissions_level|supported/);
  await assert.rejects(perm('vehicle_settings', 'read'), /supported/);
  await assert.rejects(perm('notifications', 'full'), /supported/);
  await assert.rejects(perm('vehicle_create', 'read'), /api_key_permissions_module/);
  await assert.rejects(db.query("INSERT INTO instance_flags (flag, enabled) VALUES ('other', true)"), /instance_flags/);
  // Deleting a key removes its bindings; the activity has no foreign key and stays.
  await keys.recordKeyActivity(db, { keyId: k.id as never, userId: a.id as never, keyName: 'CLI', action: 'created' });
  await db.query('DELETE FROM api_keys WHERE id = $1', [k.id]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_key_permissions WHERE key_id = $1', [k.id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM api_key_activity WHERE key_id = $1', [k.id])).rows[0].n, 2);
}));

const url = process.env['DATABASE_URL'];
async function emptyDb() {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `dl_keys_${process.pid}_${uuidv7().replace(/-/g, '').slice(-12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url!); u.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: u.toString() });
  client.on('error', () => undefined);
  await client.connect();
  return { client, url: u.toString(), async drop() { await client.end().catch(() => undefined); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); } };
}
const CREDENTIAL_TABLES = ['api_keys', 'api_key_permissions', 'api_key_vehicles', 'api_key_idempotency', 'api_key_import_previews'];

test('backups exclude key credentials and bindings; a restore leaves no keys, keeps history, and rejects archives that carry credentials', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dl-keys-'));
  const target = await emptyDb();
  try {
    await world(async ({ h, db, signUp }) => {
      const a = await signUp('a@example.test');
      const v = await mkVehicle(a);
      const k = await mkKey(a, { name: 'Backed up', vehicleIds: [v], permissions: { fuel: 'read' } });
      await mkKey(a, { name: 'Second' });
      assert.equal((await a('PATCH', `${KEYS}/${k.id}`, { name: 'Backed up 2' })).status, 200);
      await db.query("INSERT INTO api_key_idempotency (id, key_id, idempotency_key, operation, request_fingerprint, expires_at) VALUES ($1,$2,'abc','test','fp', now() + interval '1 day')", [uuidv7(), k.id]);
      await db.query("INSERT INTO api_key_import_previews (id, key_id, token_hash, target, payload_digest, expires_at) VALUES ($1,$2,$3,'new-vehicle',$4, now() + interval '1 hour')", [uuidv7(), k.id, sha256Hex('x'), sha256Hex('y')]);
      await db.query("INSERT INTO instance_flags (flag, enabled) VALUES ('api_keys', false)");
      for (const t of CREDENTIAL_TABLES) assert.ok(EPHEMERAL_TABLES.includes(t), `${t} is ephemeral`);
      assert.ok(!EPHEMERAL_TABLES.includes('api_key_activity'));
      const file = path.join(dir, 'a.dlbackup');
      const info = await createBackup(db, file);
      for (const t of CREDENTIAL_TABLES) assert.ok(!(t in info.tables), `${t} is not archived`);
      assert.equal(info.tables['api_key_activity'], 3, 'history is archived like audit_events (two creates and a rename)');
      assert.equal(info.tables['instance_flags'], 1, 'the admin choice survives');
      const text = gunzipSync(await readFile(file)).toString('utf8');
      assert.ok(!text.includes(k.token.slice(4)) && !text.includes(sha256Hex(k.token)), 'neither the token nor its hash is in the archive');

      await restoreBackup(target.client, file);
      for (const t of CREDENTIAL_TABLES) assert.equal((await target.client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, `${t} is empty after restore`);
      assert.equal((await target.client.query('SELECT count(*)::int AS n FROM api_key_activity')).rows[0].n, 3);
      assert.deepEqual((await target.client.query('SELECT enabled FROM instance_flags')).rows, [{ enabled: false }]);
      assert.equal((await target.client.query('SELECT count(*)::int AS n FROM api_key_activity WHERE key_id = $1', [k.id])).rows[0].n, 2, 'attributable history without a key');
      // The old token cannot authenticate on the restored instance.
      const restored = new pg.Pool({ connectionString: target.url, max: 2 });
      try { assert.deepEqual(await keys.lookupApiKey({ ...h.ctx, db: restored }, k.token), { ok: false, reason: 'unknown' }); } finally { await restored.end(); }
      // --replace on a live instance clears its keys too.
      await restoreBackup(target.client, file, { replace: true });
      assert.equal((await target.client.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 0);

      // An archive that carries a credential table is refused, even with a valid checksum.
      const lines = text.split('\n').filter(Boolean);
      const cols = (await db.query("SELECT array_agg(a.attname::text ORDER BY a.attnum) AS c, array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum) AS t FROM pg_attribute a WHERE a.attrelid = 'api_keys'::regclass AND a.attnum > 0 AND NOT a.attisdropped")).rows[0];
      const trailer = JSON.parse(lines.at(-1)!);
      trailer.tables['api_keys'] = 0;
      const forged = [...lines.slice(0, -1), JSON.stringify({ table: 'api_keys', columns: cols.c, types: cols.t })];
      trailer.sha256 = createHash('sha256').update(forged.map((l) => l + '\n').join('')).digest('hex');
      const bad = path.join(dir, 'forged.dlbackup');
      await writeFile(bad, gzipSync([...forged, JSON.stringify(trailer)].join('\n') + '\n'));
      await verifyBackup(bad);
      const empty = await emptyDb();
      try {
        const e = await restoreBackup(empty.client, bad).then(() => null, (x) => x);
        assert.ok(e instanceof BackupError && e.code === 'schema_mismatch', String(e));
      } finally { await empty.drop(); }
    });
  } finally { await target.drop(); await rm(dir, { recursive: true, force: true }); }
});

test('migration 0019 keeps existing data and leaves API keys enabled on an upgraded instance', { skip }, async () => {
  const { copyFile, readdir } = await import('node:fs/promises');
  const { migrate } = await import('../src/migrate.ts');
  const src = new URL('../migrations/', import.meta.url);
  const d = await mkdtemp(path.join(tmpdir(), 'mig18-'));
  for (const f of (await readdir(src)).filter((n) => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 18)) await copyFile(new URL(f, src), path.join(d, f));
  const e = await emptyDb();
  try {
    await migrate(e.client, `${d}/`);
    const uid = uuidv7();
    await e.client.query("INSERT INTO users (id, email) VALUES ($1, 'old@example.test')", [uid]);
    assert.equal((await migrate(e.client)).map((n) => n.slice(0, 4))[0], '0019');
    assert.equal((await e.client.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
    assert.equal((await e.client.query('SELECT count(*)::int AS n FROM api_keys')).rows[0].n, 0);
    assert.equal(await keys.getApiKeysEnabled(e.client), true, 'no flag row: enabled');
  } finally { await e.drop(); await rm(d, { recursive: true, force: true }); }
});

test('input parsers are strict and independent of the router', () => {
  assert.throws(() => keys.parseCreateInput(null), /JSON object/);
  assert.throws(() => keys.parseCreateInput({ name: 'x', permissions: { fuel: 'read', toString: 'read' } }), /Unknown permission module/);
  assert.throws(() => keys.parsePatchInput({ vehicleMode: 'all_current_future', vehicleIds: [uuidv7()] }), /only applies/);
  assert.deepEqual(keys.parsePatchInput({}), {});
  assert.deepEqual(keys.parseCreateInput({ name: ' a ' }), { name: 'a', expiresIn: '30d', levels: {}, vehicleCreate: false, vehicleMode: 'selected', vehicleIds: [] });
  const t = keys.generateApiToken();
  assert.ok(keys.isApiKeyToken(t.token) && t.hash === sha256Hex(t.token) && t.prefix === t.token.slice(0, 12));
  assert.ok(!keys.isApiKeyToken(`${t.token}\n`) && !keys.isApiKeyToken(undefined) && !keys.isApiKeyToken('dlk_'));
  assert.equal(new Set(Array.from({ length: 200 }, () => keys.generateApiToken().token)).size, 200);
});

