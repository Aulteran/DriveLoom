// Vehicle roles: owner, editor (shown as "Authorized Manager"), driver, viewer.
// The permission matrix over HTTP, ownership transfer and demotion, and the
// 0012 migration keeping existing rows as they were.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { migrate, MIGRATIONS_DIR } from '../src/migrate.ts';
import { uuidv7 } from '../src/ids.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { imageRoutes } from '../src/vehicles/images.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { PortabilityService } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { FriendService } from '../src/friends/service.ts';
import { friendRoutes } from '../src/friends/routes.ts';
import {
  GRANTABLE_ROLES, canArchive, canChangeFill, canEditVehicle, canManageComparison, canManageMembers, canTransferOwnership, canWriteFuel, isGrantableRole,
} from '../src/vehicles/permissions.ts';
import type { Role } from '../src/vehicles/types.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';
import { png } from './helpers/images.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp;
let owner: TestUser, editor: TestUser, driver: TestUser, viewer: TestUser, stranger: TestUser, extra: TestUser;

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, driver, viewer, stranger, extra] = await Promise.all(Array.from({ length: 6 }, () => createTestUser(db!.pool))) as TestUser[] as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles);
  app = await startApp([owner, editor, driver, viewer, stranger, extra], [
    ...vehicleRoutes(vehicles), ...imageRoutes(db.pool, vehicles), ...fuelRoutes(fuel),
    ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel)), ...friendRoutes(new FriendService(db.pool, vehicles, fuel)),
  ]);
});
after(async () => { app?.close(); await db?.drop(); });

let n = 0;
const fill = (over: Record<string, unknown> = {}) => {
  n++;
  return { occurredAt: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(), odometer: { value: String(1000 + n * 100), unit: 'km' }, volume: { value: '30', unit: 'l' }, ...over };
};
async function vehicle(): Promise<string> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Shared', odometerUnit: 'km', currency: 'EUR' });
  assert.equal(v.status, 201, v.text);
  for (const [u, role] of [[editor, 'editor'], [driver, 'driver'], [viewer, 'viewer']] as const) {
    const r = await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: u.id, role });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.role, role);
  }
  return v.json.id;
}
const addFill = async (v: string, as: TestUser) => app.call(as, 'POST', `/v1/vehicles/${v}/fill-ups`, fill());
const audit = async (v: string) => (await db!.pool.query('SELECT action, actor_id, details FROM audit_events WHERE subject_id = $1 ORDER BY id', [v])).rows;

test('permission helpers: allowlists per role', () => {
  const roles: Role[] = ['owner', 'editor', 'driver', 'viewer'];
  const row = (f: (r: Role) => boolean) => roles.map(f);
  assert.deepEqual(row(canEditVehicle), [true, true, false, false]);
  assert.deepEqual(row(canWriteFuel), [true, true, true, false]);
  assert.deepEqual(row(canManageMembers), [true, false, false, false]);
  assert.deepEqual(row(canArchive), [true, false, false, false]);
  assert.deepEqual(row(canTransferOwnership), [true, false, false, false]);
  assert.deepEqual(row(canManageComparison), [true, false, false, false]);
  const me = uuidv7(), other = uuidv7();
  assert.deepEqual(row((r) => canChangeFill(r, me, me)), [true, true, true, false]);
  assert.deepEqual(row((r) => canChangeFill(r, other, me)), [true, true, false, false]);
  assert.deepEqual(row((r) => canChangeFill(r, null, me)), [true, true, false, false], 'a driver never changes a record with no recorded author');
  assert.deepEqual([...GRANTABLE_ROLES], ['editor', 'driver', 'viewer']);
  assert.ok(!isGrantableRole('owner') && !isGrantableRole('admin') && isGrantableRole('driver'));
});

test('everyone on the vehicle reads; strangers see nothing', { skip }, async () => {
  const v = await vehicle();
  assert.equal((await addFill(v, owner)).status, 201);
  for (const [u, role] of [[owner, 'owner'], [editor, 'editor'], [driver, 'driver'], [viewer, 'viewer']] as const) {
    const got = await app.call(u, 'GET', `/v1/vehicles/${v}`);
    assert.equal(got.json.role, role);
    assert.equal((await app.call(u, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.total, 1);
    assert.equal((await app.call(u, 'GET', `/v1/vehicles/${v}/members`)).status, 200);
    assert.equal((await app.call(u, 'GET', `/v1/vehicles/${v}/stats`)).status, 200);
    assert.equal((await app.call(u, 'GET', `/v1/vehicles/${v}/export?format=csv`)).status, 200, `${role} exports`);
  }
  assert.equal((await app.call(stranger, 'GET', `/v1/vehicles/${v}`)).status, 404);
  assert.equal((await addFill(v, stranger)).status, 404);
});

test('fuel: owner and editor change any record; a driver only their own; a viewer none', { skip }, async () => {
  const v = await vehicle();
  const byOwner = (await addFill(v, owner)).json.id;
  const mine = await addFill(v, driver);
  assert.equal(mine.status, 201, mine.text);
  assert.equal(mine.json.createdBy, driver.id);
  assert.equal((await addFill(v, viewer)).status, 403);

  // Driver: own record yes, someone else's no (403, not 404: they can read it).
  assert.equal((await app.call(driver, 'PATCH', `/v1/vehicles/${v}/fill-ups/${mine.json.id}`, { notes: 'mine' })).json.notes, 'mine');
  const deny = await app.call(driver, 'PATCH', `/v1/vehicles/${v}/fill-ups/${byOwner}`, { notes: 'not mine' });
  assert.equal(deny.status, 403);
  assert.equal((await app.call(driver, 'DELETE', `/v1/vehicles/${v}/fill-ups/${byOwner}`)).status, 403);
  assert.equal((await app.call(driver, 'DELETE', `/v1/vehicles/${v}/fill-ups/${uuidv7()}`)).status, 404, 'missing stays 404');
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups/${byOwner}`)).json.notes, '', 'denied patch changed nothing');

  // Viewer: nothing.
  assert.equal((await app.call(viewer, 'PATCH', `/v1/vehicles/${v}/fill-ups/${mine.json.id}`, { notes: 'x' })).status, 403);
  assert.equal((await app.call(viewer, 'DELETE', `/v1/vehicles/${v}/fill-ups/${mine.json.id}`)).status, 403);

  // Editor: anyone's record, including the driver's.
  assert.equal((await app.call(editor, 'PATCH', `/v1/vehicles/${v}/fill-ups/${mine.json.id}`, { notes: 'fixed' })).status, 200);
  const byEditor = (await addFill(v, editor)).json.id;
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${v}/fill-ups/${byEditor}`, { notes: 'owner fix' })).status, 200);
  assert.equal((await app.call(driver, 'DELETE', `/v1/vehicles/${v}/fill-ups/${mine.json.id}`)).status, 204);
  assert.equal((await app.call(editor, 'DELETE', `/v1/vehicles/${v}/fill-ups/${byOwner}`)).status, 204);
  const actions = (await audit(v)).map((r) => r.action);
  assert.equal(actions.filter((a) => a === 'fill_up.delete').length, 2, 'only allowed deletes are audited');

  // Archived: no one writes fuel.
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true })).status, 200);
  assert.equal((await addFill(v, driver)).status, 409);
});

test('vehicle details, photo and import: owner and editor only', { skip }, async () => {
  const v = await vehicle();
  const csv = 'occurred_at,odometer,odometer_unit,volume,volume_unit\n2026-02-01T08:00:00Z,500,km,20,l\n';
  for (const [u, ok] of [[owner, true], [editor, true], [driver, false], [viewer, false]] as const) {
    const patched = await app.call(u, 'PATCH', `/v1/vehicles/${v}`, { make: 'Volvo' });
    assert.equal(patched.status, ok ? 200 : 403, `PATCH vehicle as ${u === driver ? 'driver' : u === viewer ? 'viewer' : 'manager'}`);
    const img = await app.call(u, 'PUT', `/v1/vehicles/${v}/image`, new Uint8Array(png()), { 'content-type': 'image/png' });
    assert.equal(img.status, ok ? 204 : 403);
    const imp = await app.call(u, 'POST', `/v1/vehicles/${v}/import`, { format: 'csv', data: csv, dryRun: true });
    assert.equal(imp.status, ok ? 200 : 403, imp.text);
  }
  assert.equal((await app.call(driver, 'DELETE', `/v1/vehicles/${v}/image`)).status, 403);
  assert.equal((await app.call(editor, 'DELETE', `/v1/vehicles/${v}/image`)).status, 204);
});

test('members, archive, comparison and transfer: owner only; any member may leave', { skip }, async () => {
  const v = await vehicle();
  for (const u of [editor, driver, viewer]) {
    assert.equal((await app.call(u, 'POST', `/v1/vehicles/${v}/members`, { userId: extra.id, role: 'viewer' })).status, 403);
    assert.equal((await app.call(u, 'PUT', `/v1/vehicles/${v}/members/${viewer.id}`, { role: 'driver' })).status, 403);
    assert.equal((await app.call(u, 'DELETE', `/v1/vehicles/${v}/members/${u === viewer ? driver.id : viewer.id}`)).status, 403);
    assert.equal((await app.call(u, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true })).status, 403);
    assert.equal((await app.call(u, 'PUT', `/v1/vehicles/${v}/comparison`, { enabled: true })).status, 403);
    assert.equal((await app.call(u, 'PUT', `/v1/vehicles/${v}/owner`, { userId: u.id })).status, 403);
  }
  // Grantable roles: editor, driver, viewer; never owner.
  assert.equal((await app.call(owner, 'POST', `/v1/vehicles/${v}/members`, { userId: extra.id, role: 'owner' })).status, 422);
  assert.equal((await app.call(owner, 'POST', `/v1/vehicles/${v}/members`, { userId: extra.id, role: 'admin' })).status, 422);
  assert.equal((await app.call(owner, 'POST', `/v1/vehicles/${v}/members`, { userId: extra.id, role: 'driver' })).json.role, 'driver');
  for (const role of ['viewer', 'editor', 'driver']) {
    assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/members/${extra.id}`, { role })).json.role, role);
  }
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/members/${extra.id}`, { role: 'owner' })).status, 422);
  const changes = (await audit(v)).filter((r) => r.action === 'member.role_change').map((r) => [r.details.from, r.details.to]);
  assert.deepEqual(changes, [['driver', 'viewer'], ['viewer', 'editor'], ['editor', 'driver']]);
  // A driver can leave on their own.
  assert.equal((await app.call(extra, 'DELETE', `/v1/vehicles/${v}/members/${extra.id}`)).status, 204);
  assert.equal((await app.call(extra, 'GET', `/v1/vehicles/${v}`)).status, 404);
});

test('transfer: atomic, one owner, former owner becomes an editor and can be demoted', { skip }, async () => {
  const v = await vehicle();
  const t = await app.call(owner, 'PUT', `/v1/vehicles/${v}/owner`, { userId: driver.id });
  assert.equal(t.status, 200, t.text);
  assert.equal(t.json.role, 'editor', 'the response is the former owner\'s view: now an Authorized Manager');
  const owners = await db!.pool.query("SELECT user_id FROM vehicle_members WHERE vehicle_id = $1 AND role = 'owner'", [v]);
  assert.deepEqual(owners.rows.map((r) => r.user_id), [driver.id], 'exactly one owner');
  assert.equal((await app.call(driver, 'GET', `/v1/vehicles/${v}`)).json.role, 'owner');
  const ev = (await audit(v)).filter((r) => r.action === 'owner.transfer');
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].actor_id, ev[0].details.from, ev[0].details.to], [owner.id, owner.id, driver.id]);

  // The former owner can no longer manage anything owner-only.
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/members/${viewer.id}`, { role: 'editor' })).status, 403);
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/owner`, { userId: owner.id })).status, 403);
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true })).status, 403);
  // ...but still manages the vehicle as an editor.
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { model: 'XC40' })).status, 200);

  // The new owner demotes the former owner to driver, then viewer.
  assert.equal((await app.call(driver, 'PUT', `/v1/vehicles/${v}/members/${owner.id}`, { role: 'driver' })).json.role, 'driver');
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { model: 'XC60' })).status, 403);
  assert.equal((await addFill(v, owner)).status, 201, 'as a driver they still log fuel');
  assert.equal((await app.call(driver, 'PUT', `/v1/vehicles/${v}/members/${owner.id}`, { role: 'viewer' })).json.role, 'viewer');
  assert.equal((await addFill(v, owner)).status, 403);
  // The owner role itself never changes through role change.
  assert.equal((await app.call(driver, 'PUT', `/v1/vehicles/${v}/members/${driver.id}`, { role: 'viewer' })).status, 409);
  // Transfer to a non-member is refused and leaves ownership as it was.
  assert.equal((await app.call(driver, 'PUT', `/v1/vehicles/${v}/owner`, { userId: stranger.id })).status, 422);
  const still = await db!.pool.query("SELECT user_id FROM vehicle_members WHERE vehicle_id = $1 AND role = 'owner'", [v]);
  assert.deepEqual(still.rows.map((r) => r.user_id), [driver.id]);
});

test('database: driver accepted, unknown roles refused, one owner enforced', { skip }, async () => {
  const v = await vehicle();
  await assert.rejects(db!.pool.query("UPDATE vehicle_members SET role = 'manager' WHERE vehicle_id = $1 AND user_id = $2", [v, viewer.id]), /vehicle_members_role_check/);
  await assert.rejects(db!.pool.query("UPDATE vehicle_members SET role = 'owner' WHERE vehicle_id = $1 AND user_id = $2", [v, driver.id]), /vehicle_members_one_owner/);
});

test('migration 0012 keeps existing roles and adds driver', { skip }, async () => {
  const url = process.env['DATABASE_URL']!;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `dl_test_roles_${process.pid}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'dl-mig-'));
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url); u.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    for (const f of (await readdir(dir)).filter((f) => f >= '0012')) await rm(path.join(dir, f));
    await migrate(c, dir);
    const [o, e, w] = [uuidv7(), uuidv7(), uuidv7()], vid = uuidv7();
    for (const id of [o, e, w]) await c.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await c.query("INSERT INTO vehicles (id, name) VALUES ($1, 'Old')", [vid]);
    await c.query("INSERT INTO vehicle_members (vehicle_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'editor'),($1,$4,'viewer')", [vid, o, e, w]);
    await assert.rejects(c.query("UPDATE vehicle_members SET role = 'driver' WHERE user_id = $1", [w]), /check/, 'before 0012 driver is not a role');

    assert.equal((await migrate(c))[0], '0012_vehicle_driver_role.sql');
    const roles = await c.query('SELECT user_id, role FROM vehicle_members WHERE vehicle_id = $1', [vid]);
    assert.deepEqual(Object.fromEntries(roles.rows.map((r) => [r.user_id, r.role])), { [o]: 'owner', [e]: 'editor', [w]: 'viewer' }, 'no one is elevated or changed');
    await c.query("UPDATE vehicle_members SET role = 'driver' WHERE user_id = $1", [w]);
    await assert.rejects(c.query("UPDATE vehicle_members SET role = 'superuser' WHERE user_id = $1", [w]), /vehicle_members_role_check/);
  } finally {
    await c.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});
