import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.ts';
import { authRoutes } from '../src/auth/routes.ts';
import { adminRoutes } from '../src/admin/routes.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { ORIGIN } from './helpers/index.ts';
import { harness, PW, type Harness } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

interface Client { (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>; id: string }

async function world(over: Parameters<typeof harness>[0], fn: (w: { h: Harness; anon: Client; signUp(email: string, extra?: Record<string, unknown>): Promise<Client> }) => Promise<void>) {
  const h = (await harness(over))!;
  const routes = [...authRoutes(h.ctx), ...adminRoutes(h.ctx), ...vehicleRoutes(new VehicleService(h.ctx.db))];
  const server = createServer((q, s) => void createApp({ routes, authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (cookie = '', csrf = '', id = ''): Client => Object.assign(async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }, { id });
  const anon = client();
  const signUp = async (email: string, extra: Record<string, unknown> = {}) => {
    const reg = await anon('POST', '/v1/auth/register', { email, password: PW, ...extra });
    assert.equal(reg.status, 202, JSON.stringify(reg.json));
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
    const c = client(cookie, (await res.json() as { csrf_token: string }).csrf_token);
    c.id = (await c('GET', '/v1/auth/session')).json.account.id;
    return c;
  };
  try { await fn({ h, anon, signUp }); } finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

test('invitations admit one registration while registration is closed', { skip }, () => world({ registration: 'closed' }, async ({ h, anon, signUp }) => {
  const admin = await signUp('admin@example.test');
  assert.deepEqual((await anon('GET', '/v1/auth/instance')).json, { registration: 'closed', password_login: true, oidc: true, email_recovery: true, needs_setup: false, setup_token_required: false });
  assert.equal((await anon('POST', '/v1/auth/register', { email: 'b@example.test', password: PW })).json.code, 'registration_closed');
  const open = await admin('POST', '/v1/admin/invites', {});
  assert.equal(open.status, 201);
  const bound = (await admin('POST', '/v1/admin/invites', { email: 'Carol@Example.test', expiresInDays: 1 })).json;
  assert.equal(bound.email, 'carol@example.test');
  const stored = await h.ctx.db.query('SELECT token_hash FROM invites');
  assert.ok(stored.rows.every((r) => r.token_hash !== open.json.token && r.token_hash !== bound.token), 'only hashes are stored');
  assert.ok(!JSON.stringify((await admin('GET', '/v1/admin/invites')).json).includes(open.json.token), 'tokens are never listed');

  assert.equal((await anon('POST', '/v1/auth/register', { email: 'b@example.test', password: PW, invite_token: 'wrong' })).json.code, 'registration_closed');
  assert.equal((await anon('POST', '/v1/auth/register', { email: 'b@example.test', password: PW, invite_token: bound.token })).json.code, 'registration_closed', 'bound to another address');
  const b = await signUp('b@example.test', { invite_token: open.json.token });
  assert.equal((await b('GET', '/v1/auth/session')).json.account.instanceRole, 'user');
  assert.equal((await anon('POST', '/v1/auth/register', { email: 'd@example.test', password: PW, invite_token: open.json.token })).json.code, 'registration_closed', 'single use');
  // Expiry and revocation.
  h.clock.t += 2 * 86_400_000;
  assert.equal((await anon('POST', '/v1/auth/register', { email: 'carol@example.test', password: PW, invite_token: bound.token })).json.code, 'registration_closed', 'expired');
  const admin2 = await signUp('admin@example.test').catch(() => null);
  assert.equal(admin2, null, 'the admin already exists');
}));

test('admin routes are admin-only and need recent authentication for changes', { skip }, () => world({ registration: 'open' }, async ({ h, anon, signUp }) => {
  const admin = await signUp('admin@example.test');
  const user = await signUp('user@example.test');
  for (const [m, p, b] of [['GET', '/v1/admin/users'], ['GET', '/v1/admin/invites'], ['GET', '/v1/admin/audit'], ['POST', '/v1/admin/invites', {}],
    ['PUT', `/v1/admin/users/${admin.id}/role`, { role: 'user' }], ['PUT', `/v1/admin/users/${admin.id}/status`, { status: 'disabled' }]] as const) {
    assert.equal((await user(m, p, b)).status, 403, `${m} ${p}`);
    assert.equal((await anon(m, p, b)).status, m === 'GET' ? 401 : 401, `${m} ${p} anonymous`);
  }
  const list = (await admin('GET', '/v1/admin/users')).json.items;
  assert.deepEqual(list.map((u: any) => [u.email, u.instanceRole, u.status, u.ownedVehicleCount]), [['admin@example.test', 'admin', 'active', 0], ['user@example.test', 'user', 'active', 0]]);
  assert.ok(!JSON.stringify(list).includes('hash'));
  h.clock.t += 11 * 60_000; // past the recent-authentication window
  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'disabled' })).json.code, 'reauth_required');
  assert.equal((await admin('POST', '/v1/admin/invites', {})).json.code, 'reauth_required');
  assert.equal((await admin('POST', '/v1/auth/reauth', { password: PW })).status, 204);
  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'disabled' })).status, 204);
  assert.equal((await user('GET', '/v1/auth/session')).status, 401, 'disabling revokes sessions');
  assert.equal((await anon('POST', '/v1/auth/login', { email: 'user@example.test', password: PW })).status, 401);
  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'active' })).status, 204);
  assert.equal((await anon('POST', '/v1/auth/login', { email: 'user@example.test', password: PW })).status, 200);
  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/status`, { status: 'gone' })).status, 422);
  assert.equal((await admin('PUT', '/v1/admin/users/not-an-id/status', { status: 'disabled' })).status, 404);
  const audit = (await admin('GET', '/v1/admin/audit?limit=500')).json.items.map((e: any) => e.action);
  assert.ok(audit.includes('admin.user_disabled') && audit.includes('admin.user_enabled'));
  assert.equal((await admin('GET', '/v1/admin/audit?limit=0')).status, 422);
  const page = (await admin('GET', '/v1/admin/audit?limit=2')).json.items;
  const next = (await admin('GET', `/v1/admin/audit?limit=2&before=${page[1].id}`)).json.items;
  assert.ok(next.every((e: any) => e.id < page[1].id));
}));

test('the instance always keeps an active administrator', { skip }, () => world({ registration: 'open' }, async ({ signUp }) => {
  const admin = await signUp('admin@example.test');
  const user = await signUp('user@example.test');
  assert.equal((await admin('PUT', `/v1/admin/users/${admin.id}/role`, { role: 'user' })).json.code, 'cannot_change_self');
  assert.equal((await admin('PUT', `/v1/admin/users/${admin.id}/status`, { status: 'disabled' })).json.code, 'cannot_change_self');
  assert.equal((await admin('DELETE', '/v1/auth/account')).json.code, 'last_admin');
  assert.equal((await admin('PUT', `/v1/admin/users/${user.id}/role`, { role: 'admin' })).status, 204);
  // Two admins demoting each other at once: one must fail.
  const second = await signUp('user@example.test').catch(() => null);
  assert.equal(second, null);
  const relogin = await signUp('third@example.test');
  void relogin;
  const [x, y] = await Promise.all([admin('PUT', `/v1/admin/users/${user.id}/role`, { role: 'user' }), user('PUT', `/v1/admin/users/${admin.id}/role`, { role: 'user' })]);
  assert.deepEqual([x.status, y.status].sort(), [204, 409]);
}));

test('account deletion: blocked while owning a vehicle, then removes access and frees the address', { skip }, () => world({ registration: 'open' }, async ({ h, anon, signUp }) => {
  await signUp('admin@example.test');
  const u = await signUp('leaver@example.test');
  const other = await signUp('stayer@example.test');
  assert.equal((await u('PATCH', '/v1/auth/account', { display_name: '  Lee  ' })).status, 204);
  assert.equal((await u('GET', '/v1/auth/session')).json.account.displayName, 'Lee');
  assert.equal((await u('PATCH', '/v1/auth/account', { display_name: 'x'.repeat(81) })).status, 400);
  const v = (await u('POST', '/v1/vehicles', { name: 'Mine' })).json.id;
  const shared = (await other('POST', '/v1/vehicles', { name: 'Theirs' })).json.id;
  await other('POST', `/v1/vehicles/${shared}/members`, { userId: u.id, role: 'editor' });
  const blocked = await u('DELETE', '/v1/auth/account');
  assert.deepEqual([blocked.status, blocked.json.code, blocked.json.vehicleIds], [409, 'owns_vehicles', [v]]);
  await u('POST', `/v1/vehicles/${v}/members`, { userId: other.id, role: 'viewer' });
  assert.equal((await u('PUT', `/v1/vehicles/${v}/owner`, { userId: other.id })).status, 200);
  h.clock.t += 11 * 60_000;
  assert.equal((await u('DELETE', '/v1/auth/account')).json.code, 'reauth_required');
  await u('POST', '/v1/auth/reauth', { password: PW });
  assert.equal((await u('DELETE', '/v1/auth/account')).status, 204);
  assert.equal((await u('GET', '/v1/auth/session')).status, 401);
  assert.equal((await anon('POST', '/v1/auth/login', { email: 'leaver@example.test', password: PW })).status, 401);
  assert.deepEqual((await other('GET', `/v1/vehicles/${shared}/members`)).json.items.map((m: any) => m.userId), [other.id]);
  assert.deepEqual((await other('GET', `/v1/vehicles/${v}/members`)).json.items.map((m: any) => m.userId), [other.id]);
  const row = (await h.ctx.db.query('SELECT status, email, display_name FROM users WHERE id = $1', [u.id])).rows[0];
  assert.deepEqual(row, { status: 'deleted', email: `deleted-${u.id}@deleted.invalid`, display_name: '' });
  for (const t of ['password_credentials', 'user_preferences', 'passkeys']) assert.equal((await h.ctx.db.query(`SELECT 1 FROM ${t} WHERE user_id = $1`, [u.id])).rowCount, 0, t);
  const again = await signUp('leaver@example.test'); // the address is free again
  assert.notEqual(again.id, u.id);
}));
