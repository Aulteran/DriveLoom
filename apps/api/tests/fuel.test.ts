import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp, fuel: FuelService;
let owner: TestUser, editor: TestUser, viewer: TestUser, stranger: TestUser, admin: TestUser;

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, viewer, stranger, admin] = await Promise.all([
    createTestUser(db.pool), createTestUser(db.pool), createTestUser(db.pool), createTestUser(db.pool), createTestUser(db.pool, { role: 'admin' }),
  ]) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool);
  fuel = new FuelService(db.pool, vehicles);
  app = await startApp([owner, editor, viewer, stranger, admin], [...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...preferenceRoutes(db.pool)]);
});
after(async () => { app?.close(); await db?.drop(); });

async function vehicle(over: Record<string, unknown> = {}): Promise<string> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'EUR', ...over });
  assert.equal(v.status, 201, v.text);
  await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: editor.id, role: 'editor' });
  await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: viewer.id, role: 'viewer' });
  return v.json.id;
}
const day = (n: number) => `2026-03-${String(n).padStart(2, '0')}T08:00:00Z`;
const body = (n: number, odometer: string, volume: string, over: Record<string, unknown> = {}) =>
  ({ occurredAt: day(n), odometer: { value: odometer, unit: 'km' }, volume: { value: volume, unit: 'l' }, ...over });
const add = (v: string, b: unknown, as: TestUser = owner) => app.call(as, 'POST', `/v1/vehicles/${v}/fill-ups`, b);

test('full-to-full over HTTP: originals intact, interval on the closing fill', { skip }, async () => {
  const v = await vehicle();
  assert.equal((await add(v, body(1, '10000', '45.00'))).status, 201);
  assert.equal((await add(v, body(2, '10250', '20', { full: false }))).status, 201);
  const close = await add(v, body(3, '10500', '30'));
  assert.equal(close.status, 201);
  assert.deepEqual(close.json.interval, {
    available: true, reason: null, distance: { value: '500.0', unit: 'km' }, volume: { value: '50.00', unit: 'l' }, economy: { value: '10.00', unit: 'l_per_100km' },
  });
  const list = (await app.call(viewer, 'GET', `/v1/vehicles/${v}/fill-ups`)).json;
  assert.equal(list.total, 3);
  assert.deepEqual(list.items.map((f: any) => f.odometer.value), ['10500', '10250', '10000'], 'newest first');
  assert.equal(list.items[2].volume.value, '45.00', 'entered scale is preserved');
  assert.equal(list.items[2].interval.reason, 'no_previous_full_fill');
  assert.equal(list.items[1].interval.reason, 'partial_fill');
});

test('roles: viewers read, editors write, strangers and admins see nothing', { skip }, async () => {
  const v = await vehicle();
  const made = await add(v, body(1, '100', '10'), editor);
  assert.equal(made.status, 201);
  assert.equal((await add(v, body(2, '200', '10'), viewer)).status, 403);
  assert.equal((await app.call(viewer, 'PATCH', `/v1/vehicles/${v}/fill-ups/${made.json.id}`, { notes: 'x' })).status, 403);
  assert.equal((await app.call(viewer, 'DELETE', `/v1/vehicles/${v}/fill-ups/${made.json.id}`)).status, 403);
  for (const who of [stranger, admin]) {
    assert.equal((await app.call(who, 'GET', `/v1/vehicles/${v}/fill-ups`)).status, 404);
    assert.equal((await app.call(who, 'GET', `/v1/vehicles/${v}/fill-ups/${made.json.id}`)).status, 404);
    assert.equal((await app.call(who, 'GET', `/v1/vehicles/${v}/stats`)).status, 404);
    assert.equal((await add(v, body(3, '300', '10'), who)).status, 404);
    assert.equal((await app.call(who, 'DELETE', `/v1/vehicles/${v}/fill-ups/${made.json.id}`)).status, 404);
  }
  assert.equal((await app.call(null, 'GET', `/v1/vehicles/${v}/fill-ups`)).status, 401);
  // A record id from one vehicle cannot be reached through another vehicle the caller can see.
  const other = await vehicle();
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${other}/fill-ups/${made.json.id}`)).status, 404);
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${other}/fill-ups/${made.json.id}`, { notes: 'x' })).status, 404);
});

test('odometer validation, backdates and duplicates', { skip }, async () => {
  const v = await vehicle();
  await add(v, body(1, '1000', '40'));
  await add(v, body(10, '2000', '40'));
  const low = await add(v, body(5, '900', '10'));
  assert.deepEqual([low.status, low.json.code], [422, 'odometer_out_of_sequence']);
  const high = await add(v, body(5, '2100', '10'));
  assert.deepEqual([high.status, high.json.code], [422, 'odometer_out_of_sequence']);
  const dup = await add(v, body(10, '2000', '12'));
  assert.deepEqual([dup.status, dup.json.code], [409, 'duplicate_fill_up']);
  assert.equal((await add(v, body(10, '2050', '5'))).status, 201, 'same instant, different reading is a separate purchase');
  // A backdated full fill splits the interval and repairs both neighbours.
  const before = (await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.items.find((f: any) => f.odometer.value === '2000');
  assert.equal(before.interval.distance.value, '1000.0');
  assert.equal((await add(v, body(5, '1400', '30'))).status, 201);
  const after = (await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.items;
  assert.equal(after.find((f: any) => f.odometer.value === '2000').interval.distance.value, '600.0');
  assert.equal(after.find((f: any) => f.odometer.value === '1400').interval.economy.value, '7.50');
  // Invalid input.
  for (const bad of [
    body(6, '-1', '10'), body(6, '1500', '0'), body(6, '1500.1234', '10'), { ...body(6, '1500', '10'), odometer: { value: 1500, unit: 'km' } },
    { ...body(6, '1500', '10'), volume: { value: '10' } }, { ...body(6, '1500', '10'), occurredAt: '2026-03-06' }, { ...body(6, '1500', '10'), occurredAt: '2999-01-01T00:00:00Z' },
    { ...body(6, '1500', '10'), extra: 1 }, { ...body(6, '1500', '10'), notes: 'x'.repeat(501) },
  ]) {
    const r = await add(v, bad);
    assert.deepEqual([r.status, r.json.code], [422, 'validation_failed'], JSON.stringify(bad));
  }
});

test('corrections and deletions recalculate; partial-fill boundary', { skip }, async () => {
  const v = await vehicle();
  const a = (await add(v, body(1, '5000', '40'))).json;
  const b = (await add(v, body(2, '5400', '30'))).json;
  const c = (await add(v, body(3, '5900', '35'))).json;
  assert.equal(c.interval.economy.value, '7.00');
  // Correcting the middle record to a partial fill merges two intervals into one.
  const patched = await app.call(editor, 'PATCH', `/v1/vehicles/${v}/fill-ups/${b.id}`, { full: false });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.interval.reason, 'partial_fill');
  const merged = (await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups/${c.id}`)).json.interval;
  assert.deepEqual([merged.distance.value, merged.volume.value, merged.economy.value], ['900.0', '65.00', '7.22']);
  // A correction cannot push the odometer past its neighbours.
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${v}/fill-ups/${b.id}`, { odometer: { value: '6000', unit: 'km' } })).json.code, 'odometer_out_of_sequence');
  // Deleting the partial fill removes its fuel from the interval.
  assert.equal((await app.call(owner, 'DELETE', `/v1/vehicles/${v}/fill-ups/${b.id}`)).status, 204);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups/${c.id}`)).json.interval.volume.value, '35.00');
  // Flagging a missed purchase makes the interval unavailable rather than wrong.
  await app.call(owner, 'PATCH', `/v1/vehicles/${v}/fill-ups/${c.id}`, { missedPrevious: true });
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups/${c.id}`)).json.interval.reason, 'missed_fill');
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups/${a.id}`)).status, 200);
  const audit = await db!.pool.query("SELECT action FROM audit_events WHERE subject_id = $1 AND action LIKE 'fill_up.%' ORDER BY id", [v]);
  assert.deepEqual(audit.rows.map((r) => r.action), ['fill_up.create', 'fill_up.create', 'fill_up.create', 'fill_up.update', 'fill_up.delete', 'fill_up.update']);
});

test('units: explicit at entry, originals kept, display follows the viewer', { skip }, async () => {
  const v = await vehicle({ odometerUnit: 'mi' });
  await add(v, { occurredAt: day(1), odometer: { value: '62137.119', unit: 'mi' }, volume: { value: '10', unit: 'gal_us' } });
  const second = await add(v, { occurredAt: day(2), odometer: { value: '100500', unit: 'km' }, volume: { value: '10.000', unit: 'gal_imp' } });
  assert.equal(second.status, 201, second.text);
  assert.deepEqual(second.json.odometer, { value: '100500', unit: 'km' });
  assert.deepEqual(second.json.volume, { value: '10.000', unit: 'gal_imp' });
  assert.deepEqual(second.json.display.odometer, { value: '62448', unit: 'mi' }, 'shown in the physical odometer unit');
  const stored = await db!.pool.query('SELECT volume_l::text, odometer_km::text FROM fill_ups WHERE id = $1', [second.json.id]);
  assert.deepEqual(stored.rows[0], { volume_l: '45.460900000', odometer_km: '100500.000000' });
  assert.equal(second.json.interval.economy.unit, 'l_per_100km');
  // The viewer switches to imperial; stored values and originals do not change.
  const prefs = await app.call(viewer, 'PUT', '/v1/preferences', { distanceUnit: 'mi', volumeUnit: 'gal_imp', economyUnit: 'mpg_imp' });
  assert.equal(prefs.status, 200);
  const seen = (await app.call(viewer, 'GET', `/v1/vehicles/${v}/fill-ups/${second.json.id}`)).json;
  assert.deepEqual(seen.volume, { value: '10.000', unit: 'gal_imp' });
  assert.deepEqual(seen.display.volume, { value: '10.00', unit: 'gal_imp' });
  assert.equal(seen.interval.economy.unit, 'mpg_imp');
  assert.equal(seen.interval.distance.unit, 'mi');
  const mine = (await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups/${second.json.id}`)).json;
  assert.equal(mine.interval.economy.unit, 'l_per_100km', "another member's preference is unaffected");
  assert.equal((await app.call(viewer, 'PUT', '/v1/preferences', { economyUnit: 'furlongs' })).status, 422);
  assert.equal((await app.call(viewer, 'PUT', '/v1/preferences', { currency: 'ZZZ' })).status, 422);
  assert.deepEqual((await app.call(stranger, 'GET', '/v1/preferences')).json, { distanceUnit: 'km', volumeUnit: 'l', economyUnit: 'l_per_100km', currency: 'USD' });
});

test('costs: reporting currency, explicit rate for foreign purchases, spend and cost per distance', { skip }, async () => {
  const v = await vehicle({ currency: 'EUR' });
  await add(v, body(1, '1000', '40', { cost: { amount: '70.00', currency: 'EUR' } }));
  const foreignNoRate = await add(v, body(2, '1500', '35', { cost: { amount: '60.00', currency: 'CHF' } }));
  assert.deepEqual([foreignNoRate.status, foreignNoRate.json.code], [422, 'reporting_amount_required']);
  const withRate = await add(v, body(2, '1500', '35', { cost: { amount: '60.00', currency: 'CHF', exchangeRate: '1.0637' } }));
  assert.equal(withRate.status, 201, withRate.text);
  assert.deepEqual(withRate.json.cost, { amount: '60.00', currency: 'CHF', exchangeRate: '1.0637', reportingAmount: '63.82', reportingCurrency: 'EUR' });
  const withEquivalent = await add(v, body(3, '2000', '36', { cost: { amount: '55.10', currency: 'GBP', reportingAmount: '65.00' } }));
  assert.equal(withEquivalent.json.cost.exchangeRate, null);
  assert.equal((await add(v, body(4, '2100', '5', { cost: { amount: '9', currency: 'EUR', exchangeRate: '1.1' } }))).status, 422, 'a rate on a same-currency purchase is rejected');
  assert.equal((await add(v, body(4, '2100', '5', { cost: { amount: '9', currency: 'EURO' } }))).status, 422);
  await add(v, body(5, '2500', '34')); // no cost recorded
  const s = (await app.call(owner, 'GET', `/v1/vehicles/${v}/stats`)).json;
  assert.deepEqual(s.spend, { amount: '198.82', currency: 'EUR', costedFillCount: 3 });
  assert.equal(s.intervalCount, 3);
  assert.deepEqual(s.economy, { value: '7.00', unit: 'l_per_100km' });
  // Cost per distance uses only intervals whose purchases all have a cost: (63.82 + 65.00) / 1000 km.
  assert.deepEqual(s.costPerDistance, { value: '0.1288', currency: 'EUR', per: 'km' });
  assert.equal(s.series.length, 3);
  // The reporting currency is locked once costs exist.
  const lock = await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { currency: 'USD' });
  assert.deepEqual([lock.status, lock.json.code], [409, 'currency_locked']);
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { currency: 'EUR', odometerUnit: 'mi' })).status, 200);
});

test('stats windows select intervals by their closing fill', { skip }, async () => {
  const v = await vehicle();
  await add(v, body(1, '0', '10'));
  await add(v, body(10, '500', '40'));
  await add(v, body(20, '900', '20'));
  const all = (await app.call(owner, 'GET', `/v1/vehicles/${v}/stats`)).json;
  assert.deepEqual([all.distance.value, all.economy.value, all.fillCount], ['900.0', '6.67', 3]);
  const late = (await app.call(owner, 'GET', `/v1/vehicles/${v}/stats?from=${encodeURIComponent(day(15))}`)).json;
  assert.deepEqual([late.distance.value, late.economy.value, late.fillCount], ['400.0', '5.00', 1]);
  const empty = (await app.call(owner, 'GET', `/v1/vehicles/${v}/stats?to=${encodeURIComponent(day(5))}`)).json;
  assert.deepEqual([empty.economy, empty.intervalCount], [null, 0]);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/stats?from=yesterday`)).status, 422);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/stats?from=${encodeURIComponent(day(9))}&to=${encodeURIComponent(day(2))}`)).status, 422);
});

test('archived vehicles are read-only', { skip }, async () => {
  const v = await vehicle();
  await add(v, body(1, '100', '10'));
  await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true });
  const r = await add(v, body(2, '200', '10'));
  assert.deepEqual([r.status, r.json.code], [409, 'vehicle_archived']);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.total, 1);
});

test('concurrent writers cannot break the odometer sequence or duplicate a record', { skip }, async () => {
  const v = await vehicle();
  await add(v, body(1, '1000', '10'));
  // Twenty simultaneous purchases at the same instant and reading: exactly one wins.
  const same = await Promise.all(Array.from({ length: 20 }, () => add(v, body(2, '1100', '10'))));
  assert.equal(same.filter((r) => r.status === 201).length, 1);
  assert.ok(same.every((r) => r.status === 201 || r.json.code === 'duplicate_fill_up'));
  // Racing inserts on both sides of each other: whatever order wins, the result is monotonic.
  await Promise.all(Array.from({ length: 12 }, (_, i) => add(v, body(3 + i, String(i % 2 ? 3000 - i * 50 : 1200 + i * 50), '10'))));
  const { rows } = await db!.pool.query('SELECT odometer_km::float8 AS km FROM fill_ups WHERE vehicle_id = $1 ORDER BY occurred_at, odometer_km', [v]);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].km >= rows[i - 1].km, 'odometer never decreases over time');
});
