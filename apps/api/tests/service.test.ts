// Service history: CRUD, validation (unknown vs zero cost, at least one item),
// the role matrix, the module gate, filters and paging, odometer isolation from
// fuel, and export/import (including while the module is off).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { ServiceService } from '../src/service/service.ts';
import { serviceRoutes } from '../src/service/routes.ts';
import { PortabilityService } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { setModule } from '../src/modules.ts';
import { canChangeVisit, canWriteService } from '../src/vehicles/permissions.ts';
import { uuidv7 } from '../src/ids.ts';
import type { Role } from '../src/vehicles/types.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp;
let owner: TestUser, editor: TestUser, driver: TestUser, driver2: TestUser, viewer: TestUser, stranger: TestUser;

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, driver, driver2, viewer, stranger] = await Promise.all(Array.from({ length: 6 }, () => createTestUser(db!.pool))) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles), service = new ServiceService(db.pool, vehicles);
  app = await startApp([owner, editor, driver, driver2, viewer, stranger], [
    ...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...serviceRoutes(service), ...preferenceRoutes(db.pool),
    ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel, service)),
  ]);
  await setModule(db.pool, 'service', true);
});
after(async () => { app?.close(); await db?.drop(); });

async function vehicle(over: Record<string, unknown> = {}): Promise<string> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'EUR', ...over });
  assert.equal(v.status, 201, v.text);
  for (const [u, role] of [[editor, 'editor'], [driver, 'driver'], [driver2, 'driver'], [viewer, 'viewer']] as const) {
    await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: u.id, role });
  }
  return v.json.id;
}
const visit = (over: Record<string, unknown> = {}) => ({ servicedOn: '2026-03-10', items: [{ name: 'Oil change' }], ...over });
const url = (v: string, id = '') => `/v1/vehicles/${v}/service-visits${id ? `/${id}` : ''}`;
const add = (v: string, b: unknown, as: TestUser = owner) => app.call(as, 'POST', url(v), b);

test('permission helpers: allowlists per role', () => {
  const roles: Role[] = ['owner', 'editor', 'driver', 'viewer'];
  assert.deepEqual(roles.map(canWriteService), [true, true, true, false]);
  const me = uuidv7(), other = uuidv7();
  assert.deepEqual(roles.map((r) => canChangeVisit(r, me, me)), [true, true, true, false]);
  assert.deepEqual(roles.map((r) => canChangeVisit(r, other, me)), [true, true, false, false]);
  assert.deepEqual(roles.map((r) => canChangeVisit(r, null, me)), [true, true, false, false]);
});

test('create, read, patch and delete a visit', { skip }, async () => {
  const v = await vehicle();
  const made = await add(v, visit({
    odometer: { value: '45210.5', unit: 'km' }, provider: '  Joe\'s Garage ', totalCost: '120.50', notes: 'Annual',
    items: [{ name: 'Oil change', category: 'scheduled', cost: '80.00' }, { name: 'Wipers' }, { name: 'Brake pads', category: 'repair', cost: '0', notes: 'front' }],
  }));
  assert.equal(made.status, 201, made.text);
  const j = made.json;
  assert.equal(j.servicedOn, '2026-03-10');
  assert.deepEqual(j.odometer, { value: '45210.5', unit: 'km' });
  assert.deepEqual(j.display.odometer, { value: '45211', unit: 'km' });
  assert.equal(j.provider, "Joe's Garage");
  assert.equal(j.diy, false);
  assert.equal(j.totalCost, '120.50');
  assert.equal(j.currency, 'EUR');
  assert.deepEqual(j.items.map((i: any) => [i.name, i.category, i.cost]), [['Oil change', 'scheduled', '80.00'], ['Wipers', 'other', null], ['Brake pads', 'repair', '0']]);
  assert.equal(j.createdBy, owner.id);
  assert.deepEqual((await app.call(viewer, 'GET', url(v, j.id))).json, j);

  const patched = await app.call(editor, 'PATCH', url(v, j.id), { diy: true, provider: null, odometer: null, items: [{ name: 'Tyres rotated' }] });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.diy, true);
  assert.equal(patched.json.provider, null);
  assert.equal(patched.json.odometer, null);
  assert.equal(patched.json.totalCost, '120.50', 'untouched fields are kept');
  assert.deepEqual(patched.json.items.map((i: any) => i.name), ['Tyres rotated']);
  assert.equal((await app.call(owner, 'PATCH', url(v, j.id), { notes: 'x' })).json.items.length, 1, 'items are kept when not patched');
  assert.equal((await app.call(owner, 'PATCH', url(v, j.id), {})).status, 422);

  assert.equal((await app.call(owner, 'DELETE', url(v, j.id))).status, 204);
  assert.equal((await app.call(owner, 'GET', url(v, j.id))).status, 404);
  assert.equal((await db!.pool.query('SELECT 1 FROM service_items WHERE visit_id = $1', [j.id])).rowCount, 0, 'items cascade');
  const actions = (await db!.pool.query("SELECT action FROM audit_events WHERE subject_id = $1 AND action LIKE 'service_visit.%' ORDER BY id", [v])).rows.map((r) => r.action);
  assert.deepEqual(actions, ['service_visit.create', 'service_visit.update', 'service_visit.update', 'service_visit.delete']);
});

test('validation: unknown cost is not zero, at least one item, formats and limits', { skip }, async () => {
  const v = await vehicle();
  const unknown = (await add(v, visit({ items: [{ name: 'A' }] }))).json;
  const zero = (await add(v, visit({ totalCost: '0', items: [{ name: 'A', cost: '0' }] }))).json;
  assert.equal(unknown.totalCost, null); assert.equal(unknown.items[0].cost, null);
  assert.equal(zero.totalCost, '0'); assert.equal(zero.items[0].cost, '0');
  const sum = (await add(v, visit({ totalCost: '10', items: [{ name: 'A', cost: '99' }] })));
  assert.equal(sum.status, 201, 'item costs are not checked against the visit total');
  const bad: [string, unknown][] = [
    ['no items', visit({ items: [] })], ['missing items', { servicedOn: '2026-03-10' }], ['missing date', { items: [{ name: 'A' }] }],
    ['bad date', visit({ servicedOn: '2026-02-30' })], ['datetime', visit({ servicedOn: '2026-03-10T10:00:00Z' })], ['future', visit({ servicedOn: '2999-01-01' })], ['ancient', visit({ servicedOn: '1850-01-01' })],
    ['number cost', visit({ totalCost: 12 })], ['negative cost', visit({ totalCost: '-1' })], ['too many decimals', visit({ totalCost: '1.234' })],
    ['item cost number', visit({ items: [{ name: 'A', cost: 5 }] })], ['empty item name', visit({ items: [{ name: '  ' }] })],
    ['long item name', visit({ items: [{ name: 'x'.repeat(121) }] })], ['bad category', visit({ items: [{ name: 'A', category: 'fun' }] })],
    ['long provider', visit({ provider: 'x'.repeat(121) })], ['long notes', visit({ notes: 'x'.repeat(2001) })], ['unknown field', visit({ extra: 1 })],
    ['unknown item field', visit({ items: [{ name: 'A', extra: 1 }] })], ['negative odometer', visit({ odometer: { value: '-1', unit: 'km' } })],
    ['huge odometer', visit({ odometer: { value: '99999999', unit: 'km' } })], ['odometer no unit', visit({ odometer: { value: '1' } })], ['diy string', visit({ diy: 'yes' })],
    ['51 items', visit({ items: Array.from({ length: 51 }, (_, i) => ({ name: `i${i}` })) })],
  ];
  for (const [what, b] of bad) assert.equal((await add(v, b)).status, 422, what);
  // JPY has no minor unit: whole amounts only.
  const jpy = await vehicle({ currency: 'JPY' });
  assert.equal((await add(jpy, visit({ totalCost: '5000.5' }))).status, 422);
  assert.equal((await add(jpy, visit({ totalCost: '5000' }))).status, 201);
  // PATCH cannot remove the last item.
  assert.equal((await app.call(owner, 'PATCH', url(v, unknown.id), { items: [] })).status, 422);
});

test('roles: owner and editor change any visit; driver only their own; viewer reads only', { skip }, async () => {
  const v = await vehicle();
  const mine = (await add(v, visit(), driver)).json, theirs = (await add(v, visit(), owner)).json;
  assert.equal((await add(v, visit(), viewer)).status, 403);
  assert.equal((await add(v, visit(), editor)).status, 201);
  assert.equal((await app.call(driver, 'PATCH', url(v, mine.id), { notes: 'mine' })).status, 200);
  assert.equal((await app.call(driver, 'PATCH', url(v, theirs.id), { notes: 'no' })).status, 403);
  assert.equal((await app.call(driver, 'DELETE', url(v, theirs.id))).status, 403);
  assert.equal((await app.call(driver2, 'PATCH', url(v, mine.id), { notes: 'no' })).status, 403);
  assert.equal((await app.call(viewer, 'PATCH', url(v, mine.id), { notes: 'no' })).status, 403);
  assert.equal((await app.call(viewer, 'DELETE', url(v, mine.id))).status, 403);
  assert.equal((await app.call(editor, 'PATCH', url(v, mine.id), { notes: 'manager' })).status, 200);
  assert.equal((await app.call(driver, 'DELETE', url(v, mine.id))).status, 204);
  assert.equal((await app.call(editor, 'DELETE', url(v, theirs.id))).status, 204);
  for (const who of [owner, editor, driver, viewer]) assert.equal((await app.call(who, 'GET', url(v))).status, 200);
  // Archived vehicles are read-only.
  await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true });
  assert.equal((await add(v, visit())).status, 409);
});

test('non-members get 404 and a record id cannot cross vehicles', { skip }, async () => {
  const v = await vehicle(), other = await vehicle();
  const made = (await add(v, visit())).json;
  assert.equal((await app.call(stranger, 'GET', url(v))).status, 404);
  assert.equal((await app.call(stranger, 'GET', url(v, made.id))).status, 404);
  assert.equal((await add(v, visit(), stranger)).status, 404);
  assert.equal((await app.call(stranger, 'PATCH', url(v, made.id), { notes: 'x' })).status, 404);
  assert.equal((await app.call(stranger, 'DELETE', url(v, made.id))).status, 404);
  assert.equal((await app.call(null, 'GET', url(v))).status, 401);
  assert.equal((await app.call(owner, 'GET', url(other, made.id))).status, 404);
  assert.equal((await app.call(owner, 'PATCH', url(other, made.id), { notes: 'x' })).status, 404);
  assert.equal((await app.call(owner, 'DELETE', url(other, made.id))).status, 404);
  assert.equal((await app.call(owner, 'GET', url(v, 'not-an-id'))).status, 404);
});

test('module disabled: every service route is 404 module_disabled, data is kept', { skip }, async () => {
  const v = await vehicle();
  const made = (await add(v, visit({ items: [{ name: 'Kept' }] }))).json;
  await setModule(db!.pool, 'service', false);
  try {
    for (const [m, p, b] of [['GET', url(v)], ['POST', url(v), visit()], ['GET', url(v, made.id)], ['PATCH', url(v, made.id), { notes: 'x' }], ['DELETE', url(v, made.id)]] as const) {
      const r = await app.call(owner, m, p, b);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.json.code ?? r.json.type?.split('/').pop(), 'module_disabled');
    }
    assert.equal((await app.call(stranger, 'GET', url(v))).status, 404);
    // Export still carries the visits.
    const exp = JSON.parse((await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=json`)).text);
    assert.equal(exp.serviceVisits.length, 1);
    assert.equal(exp.serviceVisits[0].items[0].name, 'Kept');
  } finally { await setModule(db!.pool, 'service', true); }
  assert.equal((await app.call(owner, 'GET', url(v, made.id))).status, 200, 're-enabling restores access to the same data');
});

test('list: newest first, filters and cursor paging', { skip }, async () => {
  const v = await vehicle();
  const mk = (d: string, name: string, extra: Record<string, unknown> = {}, category = 'other') => add(v, visit({ servicedOn: d, items: [{ name, category }], ...extra }));
  await mk('2026-01-05', 'Oil change', { provider: 'Alpha Motors' }, 'scheduled');
  await mk('2026-02-10', 'Brake pads', { notes: 'squeal 100% gone' }, 'repair');
  await mk('2026-02-10', 'Air filter', { provider: 'DIY shed', diy: true });
  await mk('2026-03-15', 'Tyres rotated', {}, 'inspection');
  await mk('2025-12-31', 'Battery');
  const names = (r: any) => r.json.items.map((i: any) => i.items[0].name);
  const all = await app.call(viewer, 'GET', url(v));
  assert.deepEqual(names(all), ['Tyres rotated', 'Air filter', 'Brake pads', 'Oil change', 'Battery'], 'service date desc, then record creation desc');
  assert.equal(all.json.nextCursor, null);
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?from=2026-02-01&to=2026-02-28`)), ['Air filter', 'Brake pads']);
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?category=repair`)), ['Brake pads']);
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?q=alpha`)), ['Oil change'], 'provider');
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?q=SQUEAL`)), ['Brake pads'], 'notes, case-insensitive');
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?q=tyres`)), ['Tyres rotated'], 'item name');
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?q=100%25`)), ['Brake pads'], 'wildcards are literal');
  assert.deepEqual(names(await app.call(owner, 'GET', `${url(v)}?q=%25`)), ['Brake pads']);
  for (const bad of ['category=nope', 'from=yesterday', 'limit=abc', 'cursor=zzzz', 'from=2026-03-01&to=2026-01-01']) assert.equal((await app.call(owner, 'GET', `${url(v)}?${bad}`)).status, 422, bad);
  // Paging walks the whole list exactly once.
  const seen: string[] = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const page = await app.call(owner, 'GET', `${url(v)}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(page.status, 200, page.text);
    seen.push(...names(page));
    if (!page.json.nextCursor) break;
    cursor = page.json.nextCursor;
  }
  assert.deepEqual(seen, names(all));
});

test('odometer is optional, any magnitude within bounds, and never touches fuel data', { skip }, async () => {
  const v = await vehicle({ odometerUnit: 'mi' });
  await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: '2026-03-01T08:00:00Z', odometer: { value: '50000', unit: 'mi' }, volume: { value: '10', unit: 'gal_us' } });
  const fuelBefore = (await db!.pool.query('SELECT * FROM fill_ups WHERE vehicle_id = $1', [v])).rows;
  const none = await add(v, visit());
  assert.equal(none.json.odometer, null); assert.equal(none.json.display.odometer, null);
  // Lower than the fuel record and in the other unit: allowed, historical entries are fine.
  const hist = await add(v, visit({ servicedOn: '2020-01-01', odometer: { value: '20000', unit: 'km' } }));
  assert.equal(hist.status, 201, hist.text);
  assert.deepEqual(hist.json.odometer, { value: '20000', unit: 'km' });
  assert.deepEqual(hist.json.display.odometer, { value: '12427', unit: 'mi' });
  assert.equal((await app.call(owner, 'PATCH', url(v, hist.json.id), { odometer: { value: '60000', unit: 'mi' } })).status, 200);
  assert.deepEqual((await db!.pool.query('SELECT * FROM fill_ups WHERE vehicle_id = $1', [v])).rows, fuelBefore, 'fuel rows are untouched');
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.total, 1);
  assert.equal((await add(v, visit({ odometer: { value: '1', unit: 'furlong' } }))).status, 422);
});

test('the reporting currency stays locked once service costs exist', { skip }, async () => {
  const v = await vehicle();
  assert.equal((await add(v, visit())).status, 201);
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { currency: 'GBP' })).status, 200, 'no costs yet');
  assert.equal((await add(v, visit({ totalCost: '10.00' }))).status, 201);
  const r = await app.call(owner, 'PATCH', `/v1/vehicles/${v}`, { currency: 'EUR' });
  assert.equal(r.status, 409);
});

test('export and import: service visits round-trip into a new vehicle and are not duplicated', { skip }, async () => {
  const v = await vehicle({ currency: 'EUR' });
  await add(v, visit({ odometer: { value: '1000', unit: 'km' }, provider: 'Alpha', totalCost: '0', notes: 'n', items: [{ name: 'Oil', category: 'scheduled', cost: '0' }, { name: 'Filter' }] }));
  await add(v, visit({ servicedOn: '2026-01-02', diy: true }));
  const csv = await app.call(viewer, 'GET', `/v1/vehicles/${v}/export?format=csv`);
  assert.equal(csv.status, 200);
  const doc = JSON.parse((await app.call(viewer, 'GET', `/v1/vehicles/${v}/export?format=json`)).text);
  assert.equal(doc.version, 1);
  assert.equal(doc.serviceVisits.length, 2);
  assert.deepEqual(doc.serviceVisits.map((s: any) => s.servicedOn), ['2026-01-02', '2026-03-10'], 'oldest first');
  assert.equal(doc.serviceVisits[1].totalCost, '0');
  assert.equal(doc.serviceVisits[0].totalCost, null);
  assert.ok(!JSON.stringify(doc.serviceVisits).includes(v), 'no ids');

  const fresh = await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: doc, dryRun: false });
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(fresh.json.serviceVisits, { total: 2, created: 2, duplicates: 0, invalid: 0 });
  const nv = fresh.json.vehicle.id as string;
  const got = (await app.call(stranger, 'GET', url(nv))).json.items;
  assert.equal(got.length, 2);
  assert.equal(got[0].totalCost, '0'); assert.equal(got[0].createdBy, stranger.id);
  assert.deepEqual(got[0].items.map((i: any) => [i.name, i.cost]), [['Oil', '0'], ['Filter', null]]);
  assert.equal(got[1].totalCost, null);

  // Importing again into the same vehicle skips what is already there.
  const again = await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: doc, dryRun: false });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json.serviceVisits, { total: 2, created: 0, duplicates: 2, invalid: 0 });
  // A dry run reports and changes nothing; an invalid visit blocks the whole import.
  const broken = { ...doc, serviceVisits: [{ servicedOn: '2026-01-01', items: [] }] };
  const dry = await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: broken });
  assert.equal(dry.json.serviceVisits.invalid, 1);
  assert.match(dry.json.errors[0].message, /^Service visit:/);
  assert.equal((await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: broken, dryRun: false })).status, 422);
  assert.equal((await app.call(stranger, 'GET', url(nv))).json.items.length, 2);
  // Older files without serviceVisits still import.
  const { serviceVisits: _omit, ...old } = doc;
  assert.equal((await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: old, dryRun: true })).json.serviceVisits, undefined);
});
