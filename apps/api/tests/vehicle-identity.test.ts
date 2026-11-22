// Optional nickname, licence plate and VIN: validation, normalisation and privacy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { FriendService } from '../src/friends/service.ts';
import { friendRoutes } from '../src/friends/routes.ts';
import { PortabilityService } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp;
let owner: TestUser, driver: TestUser, friend: TestUser, stranger: TestUser;
const NOW = new Date('2026-06-30T12:00:00Z');

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, driver, friend, stranger] = await Promise.all(['owner', 'driver', 'friend', 'stranger'].map((n) => createTestUser(db!.pool, { email: `${n}@example.test` }))) as [TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles, () => NOW);
  app = await startApp([owner, driver, friend, stranger], [
    ...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...preferenceRoutes(db.pool),
    ...friendRoutes(new FriendService(db.pool, vehicles, fuel, () => NOW)),
    ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel, () => NOW)),
  ]);
});
after(async () => { app?.close(); await db?.drop(); });

const create = (body: Record<string, unknown>) => app.call(owner, 'POST', '/v1/vehicles', { currency: 'EUR', ...body });

test('a vehicle needs no nickname; plate and VIN are optional and normalised', { skip }, async () => {
  const bare = await create({});
  assert.equal(bare.status, 201, bare.text);
  assert.deepEqual([bare.json.name, bare.json.plateRegion, bare.json.plateNumber, bare.json.vin], [null, null, null, null]);

  const v = await create({ plateRegion: ' on ', plateNumber: ' cxpz  101 ', vin: ' 1hgcm-82633a 004352 ', make: 'Honda', model: 'Civic', year: 2020 });
  assert.equal(v.status, 201, v.text);
  assert.deepEqual([v.json.name, v.json.plateRegion, v.json.plateNumber, v.json.vin], [null, 'ON', 'CXPZ 101', '1HGCM82633A004352']);

  // Blank strings from a form mean "not set"; null clears.
  const p = await app.call(owner, 'PATCH', `/v1/vehicles/${v.json.id}`, { name: 'Daily', plateRegion: '', vin: null });
  assert.deepEqual([p.json.name, p.json.plateRegion, p.json.plateNumber, p.json.vin], ['Daily', null, 'CXPZ 101', null]);
  const cleared = await app.call(owner, 'PATCH', `/v1/vehicles/${v.json.id}`, { name: null });
  assert.equal(cleared.json.name, null);
});

test('plate and VIN validation, and no uniqueness oracle', { skip }, async () => {
  for (const bad of [{ vin: 'ABC' }, { vin: '1HGCM82633A00435I' }, { vin: '1HGCM82633A0043521' }, { plateNumber: 'A'.repeat(13) }, { plateNumber: '!!!' }, { plateRegion: 'X'.repeat(11) }, { plateNumber: 5 }]) {
    assert.equal((await create(bad)).status, 422, JSON.stringify(bad));
  }
  const a = await create({ plateRegion: 'FL', plateNumber: '46FDPH', vin: '1HGCM82633A004352' });
  const b = await app.call(stranger, 'POST', '/v1/vehicles', { currency: 'EUR', plateRegion: 'FL', plateNumber: '46FDPH', vin: '1HGCM82633A004352' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201, 'another user can register the same plate or VIN without learning it exists');
});

test('plate and VIN reach members only: never friends, strangers, comparisons or the audit log', { skip }, async () => {
  const v = (await create({ name: 'Shared', plateRegion: 'ON', plateNumber: 'CXPZ101', vin: '1HGCM82633A004352', make: 'Honda', model: 'Civic', year: 2020 })).json.id as string;
  assert.equal((await app.call(owner, 'POST', `/v1/vehicles/${v}/members`, { userId: driver.id, role: 'viewer' })).status, 201);
  for (const [fillAt, odo] of [['2026-05-01T10:00:00Z', '1000'], ['2026-06-01T10:00:00Z', '1500']]) {
    assert.equal((await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: fillAt, odometer: { value: odo, unit: 'km' }, volume: { value: '30', unit: 'l' } })).status, 201);
  }
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/comparison`, { enabled: true })).status, 200);
  const req = await app.call(friend, 'POST', '/v1/friends', { email: owner.email });
  assert.equal(req.status, 200, req.text);
  const incoming = (await app.call(owner, 'GET', '/v1/friends')).json.incoming;
  assert.equal((await app.call(owner, 'PUT', `/v1/friends/${incoming[0].id}`)).status, 204);

  // Members (including a viewer) see them.
  for (const who of [owner, driver]) {
    const got = (await app.call(who, 'GET', `/v1/vehicles/${v}`)).json;
    assert.deepEqual([got.plateRegion, got.plateNumber, got.vin], ['ON', 'CXPZ101', '1HGCM82633A004352']);
    assert.equal((await app.call(who, 'GET', '/v1/vehicles')).json.items.find((x: { id: string }) => x.id === v).vin, '1HGCM82633A004352');
  }
  // A friend sees the comparison, with nothing identifying.
  const cmp = await app.call(friend, 'GET', '/v1/comparisons?window=all');
  assert.equal(cmp.json.friends[0].vehicles.length, 1, 'the friend does see the shared vehicle');
  assert.equal(cmp.json.friends[0].vehicles[0].name, 'Shared');
  for (const secret of ['CXPZ101', '1HGCM82633A004352', 'plateNumber', 'plateRegion', 'vin"']) assert.ok(!cmp.text.includes(secret), `comparison leaked ${secret}`);
  // Non-members get 404, not data.
  for (const who of [friend, stranger]) assert.equal((await app.call(who, 'GET', `/v1/vehicles/${v}`)).status, 404);
  for (const who of [friend, stranger]) assert.ok(!(await app.call(who, 'GET', '/v1/vehicles')).text.includes('CXPZ101'));
  // Their own comparison row carries the plate for the owner, not the VIN.
  const mine = (await app.call(owner, 'GET', '/v1/comparisons?window=all')).json.mine.find((x: { vehicleId: string }) => x.vehicleId === v);
  assert.deepEqual([mine.plateRegion, mine.plateNumber, mine.vin], ['ON', 'CXPZ101', undefined]);
  // The audit trail records field names, never values.
  await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { vin: '2HGCM82633A004352' });
  const { rows } = await db!.pool.query("SELECT details FROM audit_events WHERE subject_id = $1", [v]);
  assert.ok(!JSON.stringify(rows).includes('HGCM82633A004352'));
});

test('export and import work without a nickname, keep plate and VIN, and never put them in a filename', { skip }, async () => {
  const v = (await create({ plateRegion: 'FL', plateNumber: '46FDPH', vin: '1HGCM82633A004352', make: 'Ford', model: 'Focus', year: 2018 })).json.id as string;
  const csv = await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=csv`);
  assert.equal(csv.status, 200, csv.text);
  const disposition = csv.headers.get('content-disposition')!;
  assert.match(disposition, /driveloom-2018-ford-focus-/);
  assert.ok(!/46fdph|1hgcm/i.test(disposition));

  const json = await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=json`);
  const doc = JSON.parse(json.text);
  assert.deepEqual([doc.vehicle.name, doc.vehicle.plateRegion, doc.vehicle.plateNumber, doc.vehicle.vin], [null, 'FL', '46FDPH', '1HGCM82633A004352']);
  const imported = await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: doc, dryRun: false });
  assert.equal(imported.status, 200, imported.text);
  const copy = (await app.call(stranger, 'GET', `/v1/vehicles/${imported.json.vehicle.id}`)).json;
  assert.deepEqual([copy.name, copy.plateRegion, copy.plateNumber, copy.vin, copy.model], [null, 'FL', '46FDPH', '1HGCM82633A004352', 'Focus']);
});
