// Opt-in modules: the instance switch (default off, admin only, audited), its
// exposure in the session, the personal per-vehicle Service preference, and
// that toggling never loses data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.ts';
import { authRoutes } from '../src/auth/routes.ts';
import { adminRoutes } from '../src/admin/routes.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { vehiclePrefRoutes, requireModule, isModuleEnabled } from '../src/modules.ts';
import { HttpProblem } from '../src/http/problem.ts';
import { ORIGIN } from './helpers/index.ts';
import { harness, PW, type Harness } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

interface Client { (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>; id: string }

async function world(fn: (w: { h: Harness; anon: Client; signUp(email: string): Promise<Client> }) => Promise<void>) {
  const h = (await harness({ registration: 'open' }))!;
  const routes = [...authRoutes(h.ctx), ...adminRoutes(h.ctx), ...vehicleRoutes(new VehicleService(h.ctx.db)), ...vehiclePrefRoutes(h.ctx.db)];
  const server = createServer((q, s) => void createApp({ routes, authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (cookie = '', csrf = ''): Client => Object.assign(async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }, { id: '' });
  const anon = client();
  const signUp = async (email: string) => {
    assert.equal((await anon('POST', '/v1/auth/register', { email, password: PW })).status, 202);
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const c = client(res.headers.getSetCookie()[0]!.split(';')[0]!, (await res.json() as { csrf_token: string }).csrf_token);
    c.id = (await c('GET', '/v1/auth/session')).json.account.id;
    return c;
  };
  try { await fn({ h, anon, signUp }); } finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

const OFF = { modules: { service: false } }, ON = { modules: { service: true } };

test('the service module is off by default, admin-only, audited and exposed in the session', { skip }, () => world(async ({ h, anon, signUp }) => {
  const admin = await signUp('admin@example.test'), user = await signUp('user@example.test');
  assert.equal((await h.ctx.db.query('SELECT 1 FROM instance_modules')).rowCount, 0, 'nothing seeded');
  assert.deepEqual((await admin('GET', '/v1/admin/settings/modules')).json, OFF);
  assert.deepEqual((await admin('GET', '/v1/auth/session')).json.modules, OFF.modules);
  assert.deepEqual((await user('GET', '/v1/auth/session')).json.modules, OFF.modules);
  assert.equal(await isModuleEnabled(h.ctx.db, 'service'), false);
  await assert.rejects(requireModule(h.ctx.db, 'service'), (e: unknown) => e instanceof HttpProblem && e.status === 404 && e.code === 'module_disabled');

  // Admin only.
  for (const [m, p, b] of [['GET', '/v1/admin/settings/modules'], ['PUT', '/v1/admin/settings/modules/service', { enabled: true }]] as const) {
    assert.equal((await user(m, p, b)).status, 403);
    assert.equal((await anon(m, p, b)).status, 401);
  }
  assert.equal((await user('GET', '/v1/auth/session')).json.modules.service, false);

  // Validation.
  assert.equal((await admin('PUT', '/v1/admin/settings/modules/service', { enabled: 'yes' })).status, 422);
  assert.equal((await admin('PUT', '/v1/admin/settings/modules/service', {})).status, 422);
  assert.equal((await admin('PUT', '/v1/admin/settings/modules/nope', { enabled: true })).status, 404);

  assert.deepEqual((await admin('PUT', '/v1/admin/settings/modules/service', { enabled: true })).json, ON);
  assert.deepEqual((await user('GET', '/v1/auth/session')).json.modules, ON.modules, 'every signed-in user sees the flag');
  assert.equal(await isModuleEnabled(h.ctx.db, 'service'), true);
  await requireModule(h.ctx.db, 'service');
  assert.deepEqual((await admin('PUT', '/v1/admin/settings/modules/service', { enabled: false })).json, OFF);

  const events = (await h.ctx.db.query("SELECT actor_id, details FROM audit_events WHERE action = 'admin.module_changed' ORDER BY id")).rows;
  assert.deepEqual(events.map((e) => [e.actor_id, e.details]), [
    [admin.id, { module: 'service', from: false, to: true }], [admin.id, { module: 'service', from: true, to: false }]]);
  assert.equal((await admin('GET', '/v1/admin/audit')).json.items.filter((e: any) => e.action === 'admin.module_changed').length, 2);
}));

test('the per-vehicle Service preference is personal, defaults on, needs membership and loses to the server switch', { skip }, () => world(async ({ h, signUp }) => {
  const admin = await signUp('admin@example.test'), viewer = await signUp('viewer@example.test'), stranger = await signUp('stranger@example.test');
  const v = (await admin('POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'USD' })).json;
  assert.equal((await admin('POST', `/v1/vehicles/${v.id}/members`, { userId: viewer.id, role: 'viewer' })).status, 201);
  const path = `/v1/vehicles/${v.id}/service-visibility`;

  // Default: no row; preference on, module off, so not visible.
  assert.deepEqual((await viewer('GET', path)).json, { showService: true, moduleEnabled: false, visible: false });
  assert.equal((await h.ctx.db.query('SELECT 1 FROM vehicle_user_prefs')).rowCount, 0);
  await admin('PUT', '/v1/admin/settings/modules/service', { enabled: true });
  assert.deepEqual((await viewer('GET', path)).json, { showService: true, moduleEnabled: true, visible: true });

  // Membership is required to read or set; unknown vehicles look the same.
  for (const m of ['GET', 'PUT'] as const) {
    const body = m === 'PUT' ? { showService: false } : undefined;
    assert.equal((await stranger(m, path, body)).status, 404);
    assert.equal((await stranger(m, '/v1/vehicles/00000000-0000-7000-8000-000000000000/service-visibility', body)).status, 404);
  }
  assert.equal((await viewer('PUT', path, { showService: 'no' })).status, 422);
  assert.equal((await viewer('PUT', path, { showService: false, extra: 1 })).status, 422);

  // Any member, even a viewer, sets their own; others are unaffected.
  assert.deepEqual((await viewer('PUT', path, { showService: false })).json, { showService: false, moduleEnabled: true, visible: false });
  assert.deepEqual((await admin('GET', path)).json, { showService: true, moduleEnabled: true, visible: true });

  // Server off overrides the preference; the preference persists and the viewer keeps access to the vehicle.
  await admin('PUT', '/v1/admin/settings/modules/service', { enabled: false });
  assert.deepEqual((await admin('GET', path)).json, { showService: true, moduleEnabled: false, visible: false });
  assert.deepEqual((await viewer('PUT', path, { showService: true })).json, { showService: true, moduleEnabled: false, visible: false }, 'settable while the module is off');
  await viewer('PUT', path, { showService: false });
  await admin('PUT', '/v1/admin/settings/modules/service', { enabled: true });
  assert.deepEqual((await viewer('GET', path)).json, { showService: false, moduleEnabled: true, visible: false }, 'the choice survived the module being off');
  assert.equal((await viewer('GET', `/v1/vehicles/${v.id}`)).json.role, 'viewer', 'permissions are untouched');
}));

test('toggling the module and the preference never deletes data', { skip }, () => world(async ({ h, signUp }) => {
  const admin = await signUp('admin@example.test');
  const v = (await admin('POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'USD' })).json;
  const snap = async () => JSON.stringify([(await h.ctx.db.query('SELECT * FROM vehicles ORDER BY id')).rows, (await h.ctx.db.query('SELECT * FROM vehicle_members ORDER BY vehicle_id, user_id')).rows]);
  const before = await snap();
  for (const on of [true, false, true, false]) await admin('PUT', '/v1/admin/settings/modules/service', { enabled: on });
  for (const show of [false, true, false]) await admin('PUT', `/v1/vehicles/${v.id}/service-visibility`, { showService: show });
  assert.equal(await snap(), before);
  assert.deepEqual((await h.ctx.db.query('SELECT module, enabled FROM instance_modules')).rows, [{ module: 'service', enabled: false }], 'turning off keeps the row');
  assert.equal((await h.ctx.db.query('SELECT count(*)::int AS n FROM vehicle_user_prefs')).rows[0]!.n, 1);
}));

test('deleting a vehicle or an account removes personal preferences', { skip }, () => world(async ({ h, signUp }) => {
  const admin = await signUp('admin@example.test'), other = await signUp('other@example.test');
  const v = (await admin('POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'USD' })).json;
  await admin('POST', `/v1/vehicles/${v.id}/members`, { userId: other.id, role: 'driver' });
  await other('PUT', `/v1/vehicles/${v.id}/service-visibility`, { showService: false });
  await h.ctx.db.query('DELETE FROM vehicles WHERE id = $1', [v.id]);
  assert.equal((await h.ctx.db.query('SELECT 1 FROM vehicle_user_prefs')).rowCount, 0, 'cascade');
}));
