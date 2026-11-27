// Security-review fixes (phase 6): task links on visit edits (M1), vehicle create re-check (L1), the key row lock (L2),
// audit name scrubbing on account deletion (L3), hashed and extended idempotency (L4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allRoutes } from '../src/application.ts';
import * as keys from '../src/auth/api-keys.ts';
import { createApiKeyGate, recheckKeyInTx } from '../src/auth/api-key-auth.ts';
import { taskLinksChanged } from '../src/service/service.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import type { Id } from '../src/types.ts';
import { fixture, keyWorld, type Res } from './helpers/keys.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const scopeDenied = (r: Res, required: string, label = '') => {
  assert.equal(r.status, 403, `${label} ${r.text.slice(0, 300)}`);
  assert.equal(r.json?.code, 'insufficient_scope', label);
  assert.equal(r.json.required, required, label);
};

test('taskLinksChanged: only adding, changing or removing a link counts', () => {
  const T1 = '00000000-0000-7000-8000-000000000001' as Id, T2 = '00000000-0000-7000-8000-000000000002' as Id;
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: T1 }], [{ name: ' oil ', taskId: T1 }]), false);
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: null }], [{ name: 'Oil', taskId: null }]), false);
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: T1 }], [{ name: 'Oil', taskId: null }]), true);
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: T1 }], [{ name: 'Oil', taskId: T2 }]), true);
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: null }], [{ name: 'Oil', taskId: T1 }]), true);
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: T1 }], []), true, 'a dropped linked item');
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: T1 }], [{ name: 'Filter', taskId: T1 }]), true, 'a renamed linked item');
  assert.equal(taskLinksChanged([{ name: 'Oil', taskId: null }], [{ name: 'Oil', taskId: null }, { name: 'New', taskId: null }]), false);
});

test('M1: a key keeps an existing task link by echoing it; unlinking or adding one needs maintenance.read', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const V = `/v1/vehicles/${fx.vehicleId}`;
    const made = await w.call('POST', `${V}/service-visits`, { as: owner, body: { servicedOn: '2026-10-10', items: [{ name: 'Oil change', cost: '10.00', taskId: fx.taskId }] } });
    assert.equal(made.status, 201, made.text);
    const visit = `${V}/service-visits/${made.json.id}`;
    const lastCompleted = async () => (await w.call('GET', `${V}/maintenance-tasks/${fx.taskId}`, { as: owner })).json.lastCompleted;
    const before = await lastCompleted();
    assert.ok(before, 'the task is completed by the linked visit');
    const svc = w.bearer((await w.mint(owner, { permissions: { vehicle_info: 'read', service: 'read_write' }, vehicleIds: [fx.vehicleId] })).token);
    // Echoing the stored taskId while editing the cost: allowed, link intact.
    const ok = await svc('PATCH', visit, { items: [{ name: 'Oil change', cost: '12.50', taskId: fx.taskId }] });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.items[0].taskId, fx.taskId);
    assert.equal(ok.json.items[0].cost, '12.50');
    assert.deepEqual(await lastCompleted(), before);
    // Omitting taskId would sever the link: refused, nothing changed.
    scopeDenied(await svc('PATCH', visit, { items: [{ name: 'Oil change', cost: '99.00' }] }), 'maintenance.read', 'unlink');
    const after = (await svc('GET', visit)).json;
    assert.equal(after.items[0].taskId, fx.taskId);
    assert.equal(after.items[0].cost, '12.50');
    assert.deepEqual(await lastCompleted(), before);
    // Adding a link to another item also needs it.
    scopeDenied(await svc('PATCH', visit, { items: [{ name: 'Oil change', taskId: fx.taskId }, { name: 'Wipers', taskId: fx.taskId }] }), 'maintenance.read', 'add');
    // A key with maintenance.read can unlink.
    const both = w.bearer((await w.mint(owner, { permissions: { vehicle_info: 'read', service: 'read_write', maintenance: 'read' }, vehicleIds: [fx.vehicleId] })).token);
    const un = await both('PATCH', visit, { items: [{ name: 'Oil change', cost: '12.50' }] });
    assert.equal(un.status, 200, un.text);
    assert.equal(un.json.items[0].taskId, null);
    // Sessions are unaffected.
    const s = await w.call('PATCH', visit, { as: owner, body: { items: [{ name: 'Oil change', taskId: fx.taskId }] } });
    assert.equal(s.status, 200, s.text);
    assert.equal((await w.call('PATCH', visit, { as: owner, body: { items: [{ name: 'Oil change' }] } })).status, 200);
  });
});

test('L1: creating a vehicle re-checks the key inside the transaction', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const gate = createApiKeyGate(w.h.ctx);
    const vehicles = new VehicleService(w.db as never);
    const route = allRoutes(w.h.ctx).find((r) => `${r.method} ${r.path}` === 'POST /v1/vehicles')!;
    const count = async () => Number((await w.db.query('SELECT count(*) FROM vehicle_members WHERE user_id = $1', [owner.id])).rows[0].count);
    const mk = async () => {
      const k = await w.mint(owner, { permissions: { vehicle_info: 'read' }, vehicleCreate: true });
      return { ...k, p: await gate.authenticate({ token: k.token, ip: '127.0.0.1', route, params: {}, requestId: null }) };
    };
    const input = { name: 'Made', odometerUnit: 'km', currency: 'EUR' } as never;
    const ok = await mk();
    assert.equal((await vehicles.create(ok.p, input)).name, 'Made');
    const rev = await mk();
    await keys.deleteApiKey(w.h.ctx, owner.principal, rev.id);
    const before = await count();
    await assert.rejects(vehicles.create(rev.p, input), (e: any) => e.status === 401 && e.code === 'invalid_api_key');
    const off = await mk();
    await keys.updateApiKey(w.h.ctx, owner.principal, off.id, keys.parsePatchInput({ vehicleCreate: false }));
    await assert.rejects(vehicles.create(off.p, input), (e: any) => e.status === 403 && e.code === 'insufficient_scope');
    assert.equal(await count(), before, 'nothing was created by a refused attempt');
  });
});

test('L2: the re-check locks the key row, so a revoke waits for the in-flight write to commit', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const gate = createApiKeyGate(w.h.ctx);
    const route = allRoutes(w.h.ctx).find((r) => `${r.method} ${r.path}` === 'PATCH /v1/vehicles/:vehicleId')!;
    const k = await w.mint(owner, { permissions: { vehicle_settings: 'read_write', vehicle_info: 'read' }, vehicleIds: [fx.vehicleId] });
    const p = await gate.authenticate({ token: k.token, ip: '127.0.0.1', route, params: { vehicleId: fx.vehicleId }, requestId: null });
    const pool = w.db as unknown as { connect(): Promise<{ query(s: string): Promise<unknown>; release(): void }> };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await recheckKeyInTx(c as never, p, fx.vehicleId);
      let settled = false;
      const revoke = keys.deleteApiKey(w.h.ctx, owner.principal, k.id).then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(settled, false, 'revoke must wait while the write transaction holds the key');
      await c.query('COMMIT');
      await revoke;
      assert.equal(settled, true);
    } finally { c.release(); }
    // After the commit, the revocation is visible to the next re-check.
    await assert.rejects(recheckKeyInTx(w.db, p, fx.vehicleId), (e: any) => e.code === 'invalid_api_key');
  });
});

test('L3: account deletion blanks the key name in audit_events too', { skip }, async () => {
  await keyWorld(async (w) => {
    const u = await w.user();
    const other = await w.user();
    const B = await fixture(w, u);
    const O = await fixture(w, other);
    const perms = { vehicle_info: 'read', fuel: 'full' };
    const mine = await w.mint(u, { name: 'Bob private name', permissions: perms, vehicleIds: [B.vehicleId] });
    const theirs = await w.mint(other, { name: 'Other keeps name', permissions: perms, vehicleIds: [O.vehicleId] });
    const fill = { occurredAt: '2026-10-05T08:00:00Z', odometer: { value: '1100', unit: 'km' }, volume: { value: '10', unit: 'l' } };
    assert.equal((await w.call('POST', `/v1/vehicles/${B.vehicleId}/fill-ups`, { token: mine.token, body: fill })).status, 201);
    assert.equal((await w.call('POST', `/v1/vehicles/${O.vehicleId}/fill-ups`, { token: theirs.token, body: fill })).status, 201);
    const named = async (n: string) => (await w.db.query("SELECT details FROM audit_events WHERE details->'apiKey'->>'name' = $1", [n])).rowCount;
    assert.equal(await named('Bob private name'), 1);
    await w.call('PUT', `/v1/vehicles/${B.vehicleId}/archive`, { as: u, body: { archived: true } });
    assert.equal((await w.call('DELETE', `/v1/vehicles/${B.vehicleId}`, { as: u })).status, 204);
    assert.equal((await w.call('DELETE', '/v1/auth/account', { as: u })).status, 204);
    assert.equal((await w.db.query("SELECT 1 FROM audit_events WHERE details::text LIKE '%Bob private name%'")).rowCount, 0);
    const row = (await w.db.query("SELECT details FROM audit_events WHERE details->'apiKey'->>'id' = $1", [mine.id])).rows[0];
    assert.equal(row.details.apiKey.name, '');
    assert.equal(row.details.apiKey.id, mine.id, 'the id stays');
    assert.equal(await named('Other keeps name'), 1, 'other users are untouched');
  });
});

test('L4: the Idempotency-Key is stored as a SHA-256, never raw', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const { token, id } = await w.mint(owner, { permissions: { vehicle_info: 'read', fuel: 'full' }, vehicleIds: [fx.vehicleId] });
    const raw = 'client-secret-ish-key-12345';
    const url = `/v1/vehicles/${fx.vehicleId}/fill-ups`;
    const body = { occurredAt: '2026-10-05T08:00:00Z', odometer: { value: '1100', unit: 'km' }, volume: { value: '10', unit: 'l' } };
    const a = await w.call('POST', url, { token, body, headers: { 'idempotency-key': raw } });
    const b = await w.call('POST', url, { token, body, headers: { 'idempotency-key': raw } });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal(b.json.id, a.json.id);
    const rows = (await w.db.query('SELECT idempotency_key FROM api_key_idempotency WHERE key_id = $1', [id])).rows;
    assert.equal(rows.length, 1);
    const { createHash } = await import('node:crypto');
    assert.equal(rows[0].idempotency_key, createHash('sha256').update(raw).digest('hex'));
    assert.equal((await w.db.query("SELECT 1 FROM api_key_idempotency WHERE idempotency_key = $1", [raw])).rowCount, 0);
    // A different request under the same key is still a conflict.
    const c = await w.call('POST', url, { token, body: { ...body, notes: 'x' }, headers: { 'idempotency-key': raw } });
    assert.equal(c.status, 409);
    assert.equal(c.json.code, 'idempotency_conflict');
  });
});

test('L4: POST /v1/vehicles honours Idempotency-Key for keys; a replay survives deletion of the vehicle', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const { token } = await w.mint(owner, { permissions: { vehicle_info: 'read' }, vehicleCreate: true, vehicleMode: 'all_current_future' });
    const t = w.bearer(token);
    const body = { name: 'Once', odometerUnit: 'km', currency: 'EUR' };
    const count = async () => Number((await w.db.query("SELECT count(*) FROM vehicle_members WHERE user_id = $1", [owner.id])).rows[0].count);
    const a = await t('POST', '/v1/vehicles', body, { 'idempotency-key': 'veh-1' });
    assert.equal(a.status, 201, a.text);
    const b = await t('POST', '/v1/vehicles', body, { 'idempotency-key': 'veh-1' });
    assert.equal(b.status, 201);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.equal(b.json.id, a.json.id);
    assert.equal(await count(), 1);
    assert.equal((await t('POST', '/v1/vehicles', { ...body, name: 'Other' }, { 'idempotency-key': 'veh-1' })).json.code, 'idempotency_conflict');
    // Without the header a second vehicle is made (unchanged behaviour).
    assert.equal((await t('POST', '/v1/vehicles', body)).status, 201);
    assert.equal(await count(), 2);
    // Replay after deleting the vehicle returns the original response and creates nothing.
    await w.call('PUT', `/v1/vehicles/${a.json.id}/archive`, { as: owner, body: { archived: true } });
    assert.equal((await w.call('DELETE', `/v1/vehicles/${a.json.id}`, { as: owner })).status, 204);
    const c = await t('POST', '/v1/vehicles', body, { 'idempotency-key': 'veh-1' });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.json.id, a.json.id);
    assert.equal(await count(), 1);
  });
});
