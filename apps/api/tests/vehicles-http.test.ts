import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { createTestDb, createTestUser, fakeAuthenticator, noProxies, ORIGIN, type TestDb, type TestUser } from './helpers/index.ts';

let db: TestDb | null, server: Server, base: string;
let owner: TestUser, viewer: TestUser, stranger: TestUser, admin: TestUser;
const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, viewer, stranger, admin] = [
    await createTestUser(db.pool), await createTestUser(db.pool), await createTestUser(db.pool), await createTestUser(db.pool, { role: 'admin' }),
  ] as [TestUser, TestUser, TestUser, TestUser];
  const routes = vehicleRoutes(new VehicleService(db.pool));
  server = createServer(createApp({ routes, authenticator: fakeAuthenticator([owner, viewer, stranger, admin]), publicOrigin: ORIGIN, ipTrust: noProxies }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server?.close(); await db?.drop(); });

async function call(as: TestUser | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-csrf-token': 'test-csrf' };
  if (as) headers['cookie'] = `dl_session=${as.id}`;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type') ?? '', json: text ? JSON.parse(text) : undefined };
}

test('requires a session', { skip }, async () => {
  assert.equal((await call(null, 'GET', '/v1/vehicles')).status, 401);
  assert.equal((await call(null, 'POST', '/v1/vehicles', { name: 'x' })).status, 401);
});

test('create, read, edit, share, transfer end to end over HTTP', { skip }, async () => {
  const c = await call(owner, 'POST', '/v1/vehicles', { name: 'Golf', year: 2020 });
  assert.equal(c.status, 201);
  const id = c.json.id as string;
  assert.equal(c.json.role, 'owner');

  assert.equal((await call(stranger, 'GET', `/v1/vehicles/${id}`)).status, 404);
  const add = await call(owner, 'POST', `/v1/vehicles/${id}/members`, { userId: viewer.id, role: 'viewer' });
  assert.equal(add.status, 201);
  assert.equal((await call(viewer, 'GET', `/v1/vehicles/${id}`)).json.role, 'viewer');
  assert.equal((await call(viewer, 'PATCH', `/v1/vehicles/${id}`, { name: 'x' })).status, 403);
  const patched = await call(owner, 'PATCH', `/v1/vehicles/${id}`, { name: 'Golf GTI', make: null });
  assert.equal(patched.json.name, 'Golf GTI');
  assert.equal((await call(owner, 'GET', '/v1/vehicles')).json.items.length, 1);

  const bad = await call(owner, 'PUT', `/v1/vehicles/${id}/members/${viewer.id}`, { role: 'owner' });
  assert.equal(bad.status, 422);
  assert.match(bad.type, /problem\+json/);
  assert.equal(bad.json.code, 'validation_failed');

  assert.equal((await call(owner, 'PUT', `/v1/vehicles/${id}/owner`, { userId: viewer.id })).json.role, 'editor');
  assert.equal((await call(viewer, 'DELETE', `/v1/vehicles/${id}/members/${viewer.id}`)).status, 409); // new owner cannot be removed
  assert.equal((await call(viewer, 'DELETE', `/v1/vehicles/${id}/members/${owner.id}`)).status, 204);
  assert.equal((await call(owner, 'GET', `/v1/vehicles/${id}`)).status, 404);
});

test('rejects unknown fields and bad bodies', { skip }, async () => {
  assert.equal((await call(owner, 'POST', '/v1/vehicles', { name: 'x', owner: 'me' })).status, 422);
  assert.equal((await call(owner, 'POST', '/v1/vehicles', [])).status, 422);
  assert.equal((await call(owner, 'POST', '/v1/vehicles', { name: 5 })).status, 422);
  assert.equal((await call(owner, 'GET', '/v1/vehicles/not-a-uuid')).status, 404);
});

test('admin recovery route: admin only, no data access', { skip }, async () => {
  const v = (await call(owner, 'POST', '/v1/vehicles', { name: 'Lost' })).json.id as string;
  const body = { userId: stranger.id, reason: 'owner locked out' };
  assert.equal((await call(owner, 'PUT', `/v1/admin/vehicles/${v}/owner`, body)).status, 404);
  assert.equal((await call(admin, 'GET', `/v1/vehicles/${v}`)).status, 404);
  assert.equal((await call(admin, 'PUT', `/v1/admin/vehicles/${v}/owner`, body)).status, 204);
  assert.equal((await call(stranger, 'GET', `/v1/vehicles/${v}`)).json.role, 'owner');
});
