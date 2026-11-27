// Maintenance planning over HTTP: task CRUD and validation, the role matrix, the
// module gate, explicit completion links, status from service history and fuel,
// snooze conversion and visibility, helper for notifications, and export/import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { ServiceService } from '../src/service/service.ts';
import { serviceRoutes } from '../src/service/routes.ts';
import { MaintenanceService, tasksNeedingAttention } from '../src/service/maintenance.ts';
import { maintenanceRoutes } from '../src/service/maintenance-routes.ts';
import { latestKnownOdometer } from '../src/service/odometer.ts';
import { CATALOG, addDays, utcDate } from '../src/service/maintenance-status.ts';
import { PortabilityService } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { setModule } from '../src/modules.ts';
import { canManageSchedules } from '../src/vehicles/permissions.ts';
import type { Role } from '../src/vehicles/types.ts';
import type { Id } from '../src/types.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp;
let owner: TestUser, editor: TestUser, driver: TestUser, viewer: TestUser, stranger: TestUser;
let clock = new Date();
const day = (n: number) => addDays(utcDate(new Date()), n);

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, driver, viewer, stranger] = await Promise.all(Array.from({ length: 5 }, () => createTestUser(db!.pool))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles), service = new ServiceService(db.pool, vehicles);
  app = await startApp([owner, editor, driver, viewer, stranger], [
    ...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...serviceRoutes(service), ...maintenanceRoutes(new MaintenanceService(db.pool, vehicles, () => clock)), ...preferenceRoutes(db.pool),
    ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel, service)),
  ]);
  await setModule(db.pool, 'service', true);
});
after(async () => { app?.close(); await db?.drop(); });

async function vehicle(over: Record<string, unknown> = {}): Promise<string> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'EUR', ...over });
  assert.equal(v.status, 201, v.text);
  for (const [u, role] of [[editor, 'editor'], [driver, 'driver'], [viewer, 'viewer']] as const) await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: u.id, role });
  return v.json.id;
}
const T = (v: string, id = '', extra = '') => `/v1/vehicles/${v}/maintenance-tasks${id ? `/${id}` : ''}${extra}`;
const task = async (v: string, body: Record<string, unknown>, as: TestUser = owner) => { const r = await app.call(as, 'POST', T(v), body); assert.equal(r.status, 201, r.text); return r.json; };
const visit = (v: string, body: Record<string, unknown>, as: TestUser = owner) => app.call(as, 'POST', `/v1/vehicles/${v}/service-visits`, { servicedOn: day(-10), items: [{ name: 'Oil change' }], ...body });
const fill = (v: string, km: string, on = day(-1)) => app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${on}T08:00:00Z`, odometer: { value: km, unit: 'km' }, volume: { value: '10', unit: 'l' } });
const get = async (v: string, id: string, as: TestUser = owner) => (await app.call(as, 'GET', T(v, id))).json;

test('permission helper: only owner and editor manage schedules', () => {
  const roles: Role[] = ['owner', 'editor', 'driver', 'viewer'];
  assert.deepEqual(roles.map(canManageSchedules), [true, true, false, false]);
});

test('catalog is names only, and the status defaults are labelled numbers in the caller\'s unit', { skip }, async () => {
  const r = await app.call(viewer, 'GET', '/v1/maintenance-catalog');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((i: any) => i.key), CATALOG.map((c) => c.key));
  assert.ok(r.json.items.every((i: any) => Object.keys(i).sort().join() === 'key,name'), 'no intervals');
  assert.deepEqual(r.json.defaults, { leadDays: 30, leadDistance: { value: '500', unit: 'km' }, staleReadingDays: 90 });
  assert.equal((await app.call(null, 'GET', '/v1/maintenance-catalog')).status, 401);
});

test('create, read, patch, archive and delete a task', { skip }, async () => {
  const v = await vehicle();
  const made = await task(v, { name: '  Oil change ', catalogKey: 'oil_change', intervalDays: 365, intervalDistance: { value: '15000', unit: 'km' }, notes: 'full synthetic' });
  assert.equal(made.name, 'Oil change'); assert.equal(made.recurring, true); assert.equal(made.catalogKey, 'oil_change');
  assert.deepEqual(made.intervalDistance, { value: '15000', unit: 'km' });
  assert.equal(made.status, 'no_baseline', 'no completion and no first due: nothing is assumed');
  assert.equal(made.dueOn, null); assert.equal(made.lastCompleted, null); assert.equal(made.reminderSuppressed, false); assert.equal(made.needsAttention, false);
  const fromCatalog = await task(v, { catalogKey: 'wipers', intervalDays: 400 });
  assert.equal(fromCatalog.name, 'Wipers', 'the name defaults to the catalog name');
  assert.deepEqual((await app.call(viewer, 'GET', T(v))).json.items.map((t: any) => t.name), ['Oil change', 'Wipers']);

  const p = await app.call(editor, 'PATCH', T(v, made.id), { intervalDays: 180, firstDueOn: day(10) });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.dueOn, day(10)); assert.equal(p.json.status, 'due_soon'); assert.equal(p.json.baseline, 'first_due');
  assert.equal(p.json.intervalDistance.value, '15000', 'untouched fields are kept');
  assert.equal((await app.call(owner, 'PATCH', T(v, made.id), {})).status, 422);

  const arch = await app.call(owner, 'PATCH', T(v, made.id), { archived: true });
  assert.equal(arch.json.archived, true);
  assert.deepEqual((await app.call(owner, 'GET', T(v))).json.items.map((t: any) => t.name), ['Wipers']);
  assert.equal((await app.call(owner, 'GET', `${T(v)}?includeArchived=true`)).json.items.length, 2);
  assert.equal((await app.call(owner, 'GET', `${T(v)}?includeArchived=maybe`)).status, 422);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json.counts.total, 1, 'archived tasks are not counted');
  assert.equal((await app.call(owner, 'PATCH', T(v, made.id), { archived: false })).json.archived, false);

  assert.equal((await app.call(editor, 'DELETE', T(v, made.id))).status, 204);
  assert.equal((await app.call(owner, 'GET', T(v, made.id))).status, 404);
  assert.equal((await app.call(owner, 'GET', T(v, 'nope'))).status, 404);
  const actions = (await db!.pool.query("SELECT action FROM audit_events WHERE subject_id = $1 AND action LIKE 'maintenance_task.%' ORDER BY id", [v])).rows.map((r) => r.action);
  assert.deepEqual(actions, ['maintenance_task.create', 'maintenance_task.create', 'maintenance_task.update', 'maintenance_task.update', 'maintenance_task.update', 'maintenance_task.delete']);
});

test('validation: schedule shape, units and limits', { skip }, async () => {
  const v = await vehicle();
  const bad: [string, unknown][] = [
    ['no name or catalog', { intervalDays: 30 }], ['unknown catalog key', { catalogKey: 'warp_core', intervalDays: 30 }], ['empty name', { name: ' ', intervalDays: 30 }],
    ['long name', { name: 'x'.repeat(121), intervalDays: 30 }], ['repeating without interval', { name: 'A', firstDueOn: day(5) }],
    ['one-time with interval', { name: 'A', recurring: false, intervalDays: 30, firstDueOn: day(5) }], ['one-time without due point', { name: 'A', recurring: false }],
    ['zero days', { name: 'A', intervalDays: 0 }], ['fractional days', { name: 'A', intervalDays: 1.5 }], ['days as string', { name: 'A', intervalDays: '30' }], ['huge days', { name: 'A', intervalDays: 36501 }],
    ['zero distance', { name: 'A', intervalDistance: { value: '0', unit: 'km' } }], ['negative distance', { name: 'A', intervalDistance: { value: '-5', unit: 'km' } }],
    ['distance no unit', { name: 'A', intervalDistance: { value: '5' } }], ['distance number', { name: 'A', intervalDistance: { value: 5, unit: 'km' } }],
    ['bad date', { name: 'A', intervalDays: 30, firstDueOn: '2026-02-30' }], ['ancient date', { name: 'A', intervalDays: 30, firstDueOn: '1850-01-01' }],
    ['recurring string', { name: 'A', intervalDays: 30, recurring: 'yes' }], ['long notes', { name: 'A', intervalDays: 30, notes: 'x'.repeat(501) }], ['unknown field', { name: 'A', intervalDays: 30, extra: 1 }],
  ];
  for (const [what, b] of bad) assert.equal((await app.call(owner, 'POST', T(v), b)).status, 422, what);
  assert.equal((await app.call(owner, 'POST', T(v), { name: 'Distance only', intervalDistance: { value: '10000.5', unit: 'mi' } })).status, 201);
  assert.equal((await app.call(owner, 'POST', T(v), { name: 'Once', recurring: false, firstDueOdometer: { value: '120000', unit: 'km' } })).status, 201);
  // A patch that would make the merged task invalid is rejected.
  const t = await task(v, { name: 'Repeat', intervalDays: 30 });
  assert.equal((await app.call(owner, 'PATCH', T(v, t.id), { intervalDays: null })).status, 422);
  assert.equal((await app.call(owner, 'PATCH', T(v, t.id), { recurring: false })).status, 422);
});

test('roles: owner and editor manage tasks; driver and viewer read only; non-members get 404', { skip }, async () => {
  const v = await vehicle(), other = await vehicle();
  const t = await task(v, { name: 'Brakes', intervalDays: 365 }, editor);
  for (const who of [driver, viewer]) {
    assert.equal((await app.call(who, 'POST', T(v), { name: 'X', intervalDays: 1 })).status, 403);
    assert.equal((await app.call(who, 'PATCH', T(v, t.id), { name: 'X' })).status, 403);
    assert.equal((await app.call(who, 'DELETE', T(v, t.id))).status, 403);
  }
  for (const who of [owner, editor, driver, viewer]) { assert.equal((await app.call(who, 'GET', T(v))).status, 200); assert.equal((await app.call(who, 'GET', T(v, t.id))).status, 200); assert.equal((await app.call(who, 'GET', `/v1/vehicles/${v}/maintenance-status`)).status, 200); }
  for (const [m, p, b] of [['GET', T(v)], ['GET', T(v, t.id)], ['POST', T(v), { name: 'X', intervalDays: 1 }], ['PATCH', T(v, t.id), { name: 'X' }], ['DELETE', T(v, t.id)],
    ['PUT', T(v, t.id, '/snooze'), { until: day(3) }], ['DELETE', T(v, t.id, '/snooze')], ['GET', `/v1/vehicles/${v}/maintenance-status`]] as const) {
    assert.equal((await app.call(stranger, m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.equal((await app.call(null, 'GET', T(v))).status, 401);
  assert.equal((await app.call(owner, 'GET', T(other, t.id))).status, 404, 'a task id does not cross vehicles');
  assert.equal((await app.call(owner, 'DELETE', T(other, t.id))).status, 404);
  await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true });
  assert.equal((await app.call(owner, 'POST', T(v), { name: 'X', intervalDays: 1 })).status, 409);
  assert.equal((await app.call(viewer, 'PUT', T(v, t.id, '/snooze'), { until: day(3) })).status, 409, 'archived vehicles are read-only');
});

test('module disabled: every maintenance route is 404 module_disabled and data is kept', { skip }, async () => {
  const v = await vehicle();
  const t = await task(v, { name: 'Kept', intervalDays: 100 });
  await setModule(db!.pool, 'service', false);
  try {
    for (const [m, p, b] of [['GET', '/v1/maintenance-catalog'], ['GET', T(v)], ['POST', T(v), { name: 'X', intervalDays: 1 }], ['GET', T(v, t.id)], ['PATCH', T(v, t.id), { name: 'X' }], ['DELETE', T(v, t.id)],
      ['PUT', T(v, t.id, '/snooze'), { until: day(2) }], ['DELETE', T(v, t.id, '/snooze')], ['GET', `/v1/vehicles/${v}/maintenance-status`]] as const) {
      const r = await app.call(owner, m, p, b);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.json.code ?? r.json.type?.split('/').pop(), 'module_disabled');
    }
    assert.equal(JSON.parse((await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=json`)).text).maintenanceTasks[0].name, 'Kept', 'export still carries tasks');
  } finally { await setModule(db!.pool, 'service', true); }
  assert.equal((await app.call(owner, 'GET', T(v, t.id))).status, 200);
});

test('completion is an explicit link: the latest linked visit sets the next due point; deleting or editing it recomputes', { skip }, async () => {
  const v = await vehicle();
  const t = await task(v, { name: 'Oil change', intervalDays: 100, intervalDistance: { value: '10000', unit: 'km' }, firstDueOn: day(-5) });
  assert.equal(t.status, 'overdue', 'first due date is past');
  // An unlinked visit with the same item name does nothing: no automatic matching.
  assert.equal((await visit(v, { servicedOn: day(-20), items: [{ name: 'Oil change' }] })).status, 201);
  assert.equal((await get(v, t.id)).status, 'overdue');
  assert.equal((await get(v, t.id)).lastCompleted, null);
  const older = (await visit(v, { servicedOn: day(-90), odometer: { value: '30000', unit: 'km' }, items: [{ name: 'Oil + filter', taskId: t.id }] })).json;
  assert.equal(older.items[0].taskId, t.id);
  const newer = (await visit(v, { servicedOn: day(-30), odometer: { value: '40000', unit: 'km' }, items: [{ name: 'Oil', taskId: t.id }, { name: 'Wipers' }] })).json;
  let s = await get(v, t.id);
  assert.equal(s.dueOn, day(70)); assert.deepEqual(s.dueOdometer, { value: '50000', unit: 'km' });
  assert.equal(s.lastCompleted.visitId, newer.id); assert.equal(s.lastCompleted.servicedOn, day(-30)); assert.equal(s.baseline, 'completion');
  assert.equal(s.status, 'ok', 'reading is 40000 from the newer visit, today: 70 days left and 10000 km left');
  // Editing the linked visit (date) recomputes.
  await app.call(owner, 'PATCH', `/v1/vehicles/${v}/service-visits/${newer.id}`, { servicedOn: day(-99) });
  assert.equal((await get(v, t.id)).status, 'due_soon', 'moved before the older visit: the older one is now the latest completion, due in 10 days');
  assert.equal((await get(v, t.id)).lastCompleted.visitId, older.id);
  await app.call(owner, 'PATCH', `/v1/vehicles/${v}/service-visits/${newer.id}`, { servicedOn: day(-30) });
  // Removing the link by patching items recomputes too.
  await app.call(owner, 'PATCH', `/v1/vehicles/${v}/service-visits/${newer.id}`, { items: [{ name: 'Oil' }] });
  assert.equal((await get(v, t.id)).lastCompleted.visitId, older.id);
  assert.equal((await app.call(owner, 'DELETE', `/v1/vehicles/${v}/service-visits/${older.id}`)).status, 204);
  s = await get(v, t.id);
  assert.equal(s.lastCompleted, null); assert.equal(s.baseline, 'first_due'); assert.equal(s.dueOn, day(-5)); assert.equal(s.status, 'overdue');
  // Deleting the task keeps the item and clears its link.
  const linked = (await visit(v, { servicedOn: day(-2), items: [{ name: 'Oil', taskId: t.id }] })).json;
  assert.equal((await app.call(owner, 'DELETE', T(v, t.id))).status, 204);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/service-visits/${linked.id}`)).json.items[0].taskId, null);
});

test('links must name a task of the same vehicle', { skip }, async () => {
  const a = await vehicle(), b = await vehicle();
  const tb = await task(b, { name: 'Other car', intervalDays: 30 });
  assert.equal((await visit(a, { items: [{ name: 'X', taskId: tb.id }] })).status, 422);
  assert.equal((await visit(a, { items: [{ name: 'X', taskId: 'not-an-id' }] })).status, 422);
  const made = (await visit(a, {})).json;
  assert.equal((await app.call(owner, 'PATCH', `/v1/vehicles/${a}/service-visits/${made.id}`, { items: [{ name: 'X', taskId: tb.id }] })).status, 422);
  // Drivers record visits and may link them to a task they can see.
  const ta = await task(a, { name: 'Mine', intervalDays: 30 });
  assert.equal((await visit(a, { items: [{ name: 'Mine', taskId: ta.id }] }, driver)).status, 201);
  assert.equal((await get(a, ta.id, viewer)).lastCompleted.servicedOn, day(-10));
});

test('latest known odometer: fuel and service visits count, most recent by date wins, due points never do', { skip }, async () => {
  const v = await vehicle();
  assert.equal(await latestKnownOdometer(db!.pool, v as Id), null);
  await task(v, { name: 'Far', recurring: false, firstDueOdometer: { value: '999999', unit: 'km' } });
  assert.equal(await latestKnownOdometer(db!.pool, v as Id), null, 'a due odometer is not a reading');
  await fill(v, '50000', day(-40));
  let r = await latestKnownOdometer(db!.pool, v as Id);
  assert.equal(r?.km.toFixed(0), '50000'); assert.equal(r?.source, 'fuel'); assert.equal(r?.on, day(-40));
  await visit(v, { servicedOn: day(-20), odometer: { value: '50800', unit: 'km' } });
  r = await latestKnownOdometer(db!.pool, v as Id);
  assert.equal(r?.km.toFixed(0), '50800'); assert.equal(r?.source, 'service');
  await visit(v, { servicedOn: day(-60), odometer: { value: '99999', unit: 'km' } }); // a mistyped old figure must not win
  assert.equal((await latestKnownOdometer(db!.pool, v as Id))?.km.toFixed(0), '50800');
  await visit(v, { servicedOn: day(-20), odometer: { value: '50900', unit: 'km' } });
  assert.equal((await latestKnownOdometer(db!.pool, v as Id))?.km.toFixed(0), '50900', 'same day: the higher reading');
  await visit(v, { servicedOn: day(-1) }); // no odometer: not a reading
  assert.equal((await latestKnownOdometer(db!.pool, v as Id))?.km.toFixed(0), '50900');
});

test('status uses the latest reading, flags stale and missing ones, and the summary counts by status', { skip }, async () => {
  const v = await vehicle({ odometerUnit: 'mi' });
  const dist = await task(v, { name: 'Distance', intervalDistance: { value: '5000', unit: 'mi' }, firstDueOdometer: { value: '20000', unit: 'mi' } });
  const timed = await task(v, { name: 'Timed', intervalDays: 365, firstDueOn: day(200) });
  const once = await task(v, { name: 'Once', recurring: false, firstDueOn: day(-3) });
  await task(v, { name: 'Nothing', intervalDays: 10 });
  let sum = (await app.call(viewer, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json;
  assert.equal(sum.reading, null);
  assert.deepEqual([sum.counts.unknown_reading, sum.counts.ok, sum.counts.overdue, sum.counts.no_baseline, sum.counts.total], [1, 1, 1, 1, 4]);
  assert.equal((await get(v, dist.id)).readingStale, true, 'no reading at all');
  assert.equal((await get(v, timed.id)).readingStale, false, 'time-only tasks never need a reading');
  await fill(v, '30000', day(-2)); // km: about 18641 mi, 1359 mi short of due
  const s = await get(v, dist.id);
  assert.equal(s.status, 'ok'); assert.equal(s.readingStale, false); assert.deepEqual(s.dueOdometer, { value: '20000', unit: 'mi' });
  assert.deepEqual(s.distanceUntilDue, { value: '1359', unit: 'mi' });
  await fill(v, '31000', day(-1)); // 19262 mi: 738 mi short of due; lead is 500 in the caller's unit (km by default)
  assert.equal((await get(v, dist.id)).status, 'ok');
  await fill(v, '32500', day(0)); // 20195 mi: past due
  assert.equal((await get(v, dist.id)).status, 'overdue');
  sum = (await app.call(viewer, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json;
  assert.deepEqual(sum.reading.odometer, { value: '20195', unit: 'mi' }); assert.equal(sum.reading.stale, false); assert.equal(sum.reading.source, 'fuel');
  assert.equal(sum.counts.overdue, 2); assert.equal(sum.counts.needsAttention, 2); assert.equal(sum.counts.remindersActive, 2);
  // An old reading is flagged stale, never projected.
  clock = new Date(Date.now() + 120 * 86_400_000);
  try {
    const old = await get(v, timed.id);
    assert.equal(old.status, 'ok', 'still 80 days away');
    const o = await get(v, dist.id);
    assert.equal(o.status, 'overdue', 'an old reading past due still proves overdue');
    assert.equal(o.readingStale, true);
    assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json.reading.stale, true);
  } finally { clock = new Date(); }
  assert.equal((await get(v, once.id)).status, 'overdue');
  await visit(v, { servicedOn: day(-1), items: [{ name: 'Once', taskId: once.id }] });
  assert.equal((await get(v, once.id)).status, 'completed');
});

test('snooze: personal for any member, vehicle-wide for owner and editor; status never changes', { skip }, async () => {
  const v = await vehicle();
  const t = await task(v, { name: 'Overdue thing', intervalDays: 30, firstDueOn: day(-10) });
  assert.equal(t.status, 'overdue');
  const mine = await app.call(viewer, 'PUT', T(v, t.id, '/snooze'), { until: day(7), reason: 'in the shop next week' });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.status, 'overdue', 'overdue stays overdue'); assert.equal(mine.json.dueOn, day(-10)); assert.equal(mine.json.needsAttention, true);
  assert.equal(mine.json.reminderSuppressed, true);
  assert.equal(mine.json.snoozed.scope, 'personal'); assert.equal(mine.json.snoozed.until, day(7)); assert.equal(mine.json.snoozed.reason, 'in the shop next week');
  // Personal snoozes are private.
  for (const who of [owner, editor, driver]) { const x = await get(v, t.id, who); assert.equal(x.snoozed, null); assert.equal(x.reminderSuppressed, false); }
  // Vehicle-wide: managers only, and everyone sees it.
  for (const who of [driver, viewer]) assert.equal((await app.call(who, 'PUT', `${T(v, t.id, '/snooze')}?scope=vehicle`, { until: day(3) })).status, 403);
  for (const who of [driver, viewer]) assert.equal((await app.call(who, 'DELETE', `${T(v, t.id, '/snooze')}?scope=vehicle`)).status, 403);
  assert.equal((await app.call(editor, 'PUT', `${T(v, t.id, '/snooze')}?scope=vehicle`, { until: day(3) })).status, 200);
  for (const who of [owner, driver]) { const x = await get(v, t.id, who); assert.equal(x.snoozed.scope, 'vehicle'); assert.equal(x.reminderSuppressed, true); assert.equal(x.status, 'overdue'); }
  const both = await get(v, t.id, viewer);
  assert.deepEqual(both.snoozes.map((x: any) => x.scope), ['personal', 'vehicle']); assert.equal(both.snoozed.scope, 'personal');
  // Setting again replaces; the owner can clear the vehicle one; clearing nothing is fine.
  assert.equal((await app.call(editor, 'PUT', `${T(v, t.id, '/snooze')}?scope=vehicle`, { until: day(5) })).json.snoozed.until, day(5));
  assert.equal((await db!.pool.query('SELECT 1 FROM task_snoozes WHERE task_id = $1', [t.id])).rowCount, 2, 'one row per task and scope');
  assert.equal((await app.call(owner, 'DELETE', `${T(v, t.id, '/snooze')}?scope=vehicle`)).json.snoozed, null);
  assert.equal((await app.call(owner, 'DELETE', `${T(v, t.id, '/snooze')}?scope=vehicle`)).status, 200);
  assert.equal((await app.call(viewer, 'DELETE', T(v, t.id, '/snooze'))).json.snoozed, null);
  const actions = (await db!.pool.query("SELECT action FROM audit_events WHERE subject_id = $1 AND action LIKE 'maintenance_snooze.%' ORDER BY id", [v])).rows.map((r) => r.action);
  assert.deepEqual(actions, ['maintenance_snooze.set', 'maintenance_snooze.set', 'maintenance_snooze.set', 'maintenance_snooze.clear', 'maintenance_snooze.clear']);
  // Snoozing never reschedules or completes.
  const after = await get(v, t.id);
  assert.equal(after.dueOn, day(-10)); assert.equal(after.lastCompleted, null);
});

test('snooze validation, distance conversion and expiry by date and by odometer', { skip }, async () => {
  const v = await vehicle({ odometerUnit: 'mi' });
  const t = await task(v, { name: 'Tyres', intervalDistance: { value: '6000', unit: 'mi' }, firstDueOdometer: { value: '40000', unit: 'mi' } });
  const snooze = (b: unknown, q = '') => app.call(owner, 'PUT', `${T(v, t.id, '/snooze')}${q}`, b);
  // No reading yet: a distance snooze cannot be converted, and nothing is stored.
  const none = await snooze({ additionalDistance: { value: '300', unit: 'mi' } });
  assert.equal(none.status, 422); assert.match(none.json.detail ?? none.text, /No odometer reading is known/);
  assert.equal((await db!.pool.query('SELECT 1 FROM task_snoozes')).rowCount, 0);
  for (const [what, b] of [['empty', {}], ['past date', { until: day(-1) }], ['far date', { until: day(4000) }], ['both distances', { untilOdometer: { value: '1', unit: 'mi' }, additionalDistance: { value: '1', unit: 'mi' } }],
    ['zero add', { additionalDistance: { value: '0', unit: 'mi' } }], ['no unit', { additionalDistance: { value: '5' } }], ['long reason', { until: day(1), reason: 'x'.repeat(201) }], ['unknown field', { until: day(1), x: 1 }]] as const) {
    assert.equal((await snooze(b)).status, 422, what);
  }
  assert.equal((await snooze({ until: day(1) }, '?scope=nope')).status, 422);
  // An absolute target is accepted without a reading; it stays active until a reading passes it.
  assert.equal((await snooze({ untilOdometer: { value: '39000', unit: 'mi' } })).json.reminderSuppressed, true);
  // With a reading the additional distance is converted once to an absolute target.
  await fill(v, '60000', day(-1)); // 37282.27 mi
  const conv = await snooze({ additionalDistance: { value: '300', unit: 'mi' } });
  assert.equal(conv.status, 200, conv.text);
  const stored = (await db!.pool.query("SELECT snooze_until_odometer_km::text AS km FROM task_snoozes WHERE scope = 'personal'")).rows[0].km;
  assert.equal(Number(stored).toFixed(3), (60000 + 300 * 1.609344).toFixed(3));
  assert.deepEqual(conv.json.snoozed.untilOdometer, { value: '37582', unit: 'mi' });
  await fill(v, '60400', day(0)); // the reading moves; the stored target does not
  assert.equal((await db!.pool.query("SELECT snooze_until_odometer_km::text AS km FROM task_snoozes WHERE scope = 'personal'")).rows[0].km, stored, 'converted once');
  assert.equal((await get(v, t.id)).reminderSuppressed, true, '37531 mi is below the target of 37582 mi');
  assert.equal((await snooze({ untilOdometer: { value: '100', unit: 'mi' } })).status, 422, 'a target the vehicle has already passed');
  await fill(v, '60600', day(0)); // 37655 mi: passed the target
  const passed = await get(v, t.id);
  assert.equal(passed.reminderSuppressed, false, 'the odometer passed the target, which ends the snooze'); assert.equal(passed.snoozed, null);
  // Date and distance together: whichever comes first ends it.
  await snooze({ until: day(10), additionalDistance: { value: '2000', unit: 'km' } });
  assert.equal((await get(v, t.id)).reminderSuppressed, true);
  clock = new Date(Date.now() + 11 * 86_400_000);
  try { assert.equal((await get(v, t.id)).reminderSuppressed, false, 'the date passed first'); } finally { clock = new Date(); }
  assert.equal((await get(v, t.id)).reminderSuppressed, true);
  await fill(v, '63000', day(0));
  assert.equal((await get(v, t.id)).reminderSuppressed, false, 'the distance passed first');
});

test('tasksNeedingAttention: due soon and overdue tasks with the person\'s effective snooze', { skip }, async () => {
  const v = await vehicle();
  const a = await task(v, { name: 'A overdue', intervalDays: 30, firstDueOn: day(-3) });
  await task(v, { name: 'B soon', intervalDays: 30, firstDueOn: day(10) });
  await task(v, { name: 'C far', intervalDays: 30, firstDueOn: day(100) });
  await task(v, { name: 'D none', intervalDays: 30 });
  await app.call(viewer, 'PUT', T(v, a.id, '/snooze'), { until: day(2) });
  const mine = await tasksNeedingAttention(db!.pool, v as Id, viewer.id as Id);
  assert.deepEqual(mine.map((t) => [t.name, t.status, t.reminderSuppressed]), [['A overdue', 'overdue', true], ['B soon', 'due_soon', false]]);
  const others = await tasksNeedingAttention(db!.pool, v as Id, driver.id as Id);
  assert.deepEqual(others.map((t) => [t.name, t.reminderSuppressed]), [['A overdue', false], ['B soon', false]]);
  const sum = (await app.call(viewer, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json.counts;
  assert.deepEqual([sum.needsAttention, sum.remindersActive, sum.snoozed], [2, 1, 1]);
});

test('export and import: tasks, links and vehicle-wide snoozes round-trip; personal snoozes and duplicates do not', { skip }, async () => {
  const v = await vehicle({ currency: 'EUR' });
  const oil = await task(v, { name: 'Oil change', catalogKey: 'oil_change', intervalDays: 365, intervalDistance: { value: '15000', unit: 'km' }, notes: 'n' });
  const once = await task(v, { name: 'Inspection', recurring: false, firstDueOn: day(30) });
  const gone = await task(v, { name: 'Archived one', intervalDays: 10 });
  await app.call(owner, 'PATCH', T(v, gone.id), { archived: true });
  await app.call(editor, 'PUT', `${T(v, oil.id, '/snooze')}?scope=vehicle`, { until: day(20), reason: 'waiting for parts' });
  await app.call(viewer, 'PUT', T(v, once.id, '/snooze'), { until: day(20) });
  await visit(v, { servicedOn: day(-30), odometer: { value: '1000', unit: 'km' }, items: [{ name: 'Oil', taskId: oil.id }, { name: 'Wipers' }] });
  const doc = JSON.parse((await app.call(viewer, 'GET', `/v1/vehicles/${v}/export?format=json`)).text);
  assert.equal(doc.maintenanceTasks.length, 3);
  assert.deepEqual(doc.maintenanceTasks.map((t: any) => t.ref), ['t1', 't2', 't3']);
  assert.deepEqual(doc.maintenanceTasks[0].snooze, { until: day(20), untilOdometer: null, reason: 'waiting for parts' });
  assert.equal(doc.maintenanceTasks[2].archived, true);
  assert.ok(JSON.stringify(doc).indexOf(oil.id) < 0, 'no ids');
  assert.deepEqual(doc.serviceVisits[0].items.map((i: any) => i.taskRef ?? null), ['t1', null]);
  assert.equal(JSON.stringify(doc.maintenanceTasks).includes('personal'), false);

  const fresh = await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: doc, dryRun: false });
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(fresh.json.maintenanceTasks, { total: 3, created: 3, duplicates: 0, invalid: 0 });
  const nv = fresh.json.vehicle.id as string;
  const tasks = (await app.call(stranger, 'GET', `${T(nv)}?includeArchived=true`)).json.items;
  assert.deepEqual(tasks.map((t: any) => t.name), ['Oil change', 'Inspection', 'Archived one']);
  assert.equal(tasks[0].createdBy, stranger.id);
  assert.equal(tasks[0].lastCompleted.servicedOn, day(-30), 'the link followed the import');
  assert.deepEqual(tasks[0].dueOdometer, { value: '16000', unit: 'km' });
  assert.equal(tasks[0].snoozed.scope, 'vehicle'); assert.equal(tasks[0].snoozed.until, day(20));
  assert.equal(tasks[1].snoozed, null, 'a personal snooze is not carried');
  assert.equal(tasks[2].archived, true);
  assert.equal((await db!.pool.query("SELECT 1 FROM task_snoozes WHERE scope = 'personal' AND task_id = ANY($1::uuid[])", [tasks.map((t: any) => t.id)])).rowCount, 0);

  // Importing again skips identical tasks and visits, and links still resolve.
  const again = await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: doc, dryRun: false });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json.maintenanceTasks, { total: 3, created: 0, duplicates: 3, invalid: 0 });
  assert.deepEqual(again.json.serviceVisits, { total: 1, created: 0, duplicates: 1, invalid: 0 });
  assert.equal((await app.call(stranger, 'GET', `${T(nv)}?includeArchived=true`)).json.items.length, 3);
  // Invalid tasks and dangling refs block the import; a dry run changes nothing.
  const bad = { ...doc, maintenanceTasks: [{ ref: 'x', name: 'Bad', recurring: true }], serviceVisits: [{ servicedOn: day(-1), items: [{ name: 'Z', taskRef: 'nope' }] }] };
  const dry = await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: bad });
  assert.equal(dry.json.maintenanceTasks.invalid, 1); assert.equal(dry.json.serviceVisits.invalid, 1);
  assert.match(dry.json.errors.map((e: any) => e.message).join('|'), /Maintenance task:.*Service visit:|Service visit:.*Maintenance task:/);
  assert.equal((await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: bad, dryRun: false })).status, 422);
  const literal = { ...doc, serviceVisits: [{ servicedOn: day(-1), items: [{ name: 'Z', taskId: oil.id }] }] };
  assert.equal((await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: literal })).json.serviceVisits.invalid, 1, 'ids from another vehicle are rejected');
  // Older files without maintenanceTasks still import, and importing into a role without edit rights is refused.
  const { maintenanceTasks: _omit, ...old } = doc;
  assert.equal((await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: old, dryRun: true })).json.maintenanceTasks, undefined);
  assert.equal((await app.call(viewer, 'POST', `/v1/vehicles/${v}/import`, { format: 'json', data: doc })).status, 403);
});

test('deleting a vehicle removes its tasks and snoozes', { skip }, async () => {
  const v = await vehicle();
  const t = await task(v, { name: 'Gone soon', intervalDays: 10 });
  await app.call(owner, 'PUT', T(v, t.id, '/snooze'), { until: day(2) });
  await db!.pool.query('DELETE FROM vehicles WHERE id = $1', [v]);
  assert.equal((await db!.pool.query('SELECT 1 FROM maintenance_tasks WHERE vehicle_id = $1', [v])).rowCount, 0);
  assert.equal((await db!.pool.query('SELECT 1 FROM task_snoozes WHERE task_id = $1', [t.id])).rowCount, 0);
});

// ---------- months, task baselines, reminders switch and preset provenance (presets, Phase A) ----------
const PRESET = { presetId: 'us-honda-odyssey-2015', presetVersion: 1, presetTaskId: 'brake-fluid' };
const PROVENANCE = { ...PRESET, sourceTrust: 'manufacturer', sourceNote: 'manual' };
/** Provenance is not writable over the public API; seed it the way applyPreset does (straight into the row). */
async function seedProvenance(id: string, p: Record<string, unknown> = PROVENANCE) {
  await db!.pool.query('UPDATE maintenance_tasks SET preset_id = $2, preset_version = $3, preset_task_id = $4, source_trust = $5, source_note = $6 WHERE id = $1',
    [id, p['presetId'], p['presetVersion'], p['presetTaskId'], p['sourceTrust'], p['sourceNote']]);
}

test('months, baselines, reminders and provenance: create, read, patch, validate', { skip }, async () => {
  const v = await vehicle({ odometerUnit: 'mi' });
  const made = await task(v, { catalogKey: 'brake_fluid', intervalMonths: 36, baselineKind: 'reported', baselineOn: '2024-05-10', remindersEnabled: false });
  await seedProvenance(made.id, { ...PROVENANCE, sourceNote: 'Owner\'s manual maintenance section' });
  const brake = await get(v, made.id);
  assert.equal(brake.intervalMonths, 36); assert.equal(brake.intervalDays, null);
  assert.equal(brake.baselineKind, 'reported'); assert.equal(brake.baselineOn, '2024-05-10'); assert.equal(brake.baselineOdometer, null);
  assert.equal(brake.baseline, 'reported'); assert.equal(brake.dueOn, '2027-05-10', 'acceptance 2 end to end');
  assert.equal(brake.lastCompleted, null, 'a reported baseline is not a service record');
  assert.equal(brake.remindersEnabled, false); assert.equal(brake.sourceTrust, 'manufacturer');
  assert.deepEqual([brake.presetId, brake.presetVersion, brake.presetTaskId], ['us-honda-odyssey-2015', 1, 'brake-fluid']);
  // Typed-in tasks keep the defaults: reminders on, no provenance, no baseline.
  const manual = await task(v, { name: 'Wipers', intervalDays: 365 });
  assert.equal(manual.remindersEnabled, true); assert.equal(manual.presetId, null); assert.equal(manual.baselineKind, null); assert.equal(manual.intervalMonths, null);

  // Start tracking now: provisional due point, never "ok".
  const oil = await task(v, { catalogKey: 'oil_change', intervalMonths: 6, intervalDistance: { value: '5000', unit: 'mi' }, baselineKind: 'tracking', baselineOn: day(0), baselineOdometer: { value: '80000', unit: 'mi' } });
  assert.equal(oil.baseline, 'tracking'); assert.equal(oil.status, 'unknown_reading', 'no odometer reading yet'); assert.deepEqual(oil.dueOdometer, { value: '85000', unit: 'mi' }); assert.ok(oil.dueOn);
  await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(0)}T08:00:00Z`, odometer: { value: '80100', unit: 'mi' }, volume: { value: '10', unit: 'l' } });
  assert.equal((await get(v, oil.id)).status, 'no_baseline', 'with a fresh reading far from due: still not "ok", because tracking is not a completion');
  assert.deepEqual(oil.baselineOdometer, { value: '80000', unit: 'mi' });

  // Switching from days to months needs the days cleared; both at once is refused.
  assert.equal((await app.call(owner, 'PATCH', T(v, manual.id), { intervalMonths: 12 })).status, 422);
  const sw = await app.call(owner, 'PATCH', T(v, manual.id), { intervalDays: null, intervalMonths: 12 });
  assert.equal(sw.status, 200, sw.text); assert.equal(sw.json.intervalMonths, 12); assert.equal(sw.json.intervalDays, null);
  // Clearing a baseline.
  const cleared = await app.call(owner, 'PATCH', T(v, oil.id), { baselineKind: null, baselineOn: null, baselineOdometer: null });
  assert.equal(cleared.json.baseline, 'none'); assert.equal(cleared.json.status, 'no_baseline'); assert.equal(cleared.json.dueOn, null);
  // Untouched new fields survive an unrelated patch.
  const renamed = await app.call(owner, 'PATCH', T(v, brake.id), { name: 'Brake fluid (DOT 3)' });
  const nul = await app.call(owner, 'PATCH', T(v, brake.id), { remindersEnabled: null });
  assert.equal(nul.status, 422, 'null never turns reminders on'); assert.equal((await get(v, brake.id)).remindersEnabled, false);
  assert.equal(renamed.json.presetTaskId, 'brake-fluid'); assert.equal(renamed.json.baselineOn, '2024-05-10'); assert.equal(renamed.json.remindersEnabled, false); assert.equal(renamed.json.intervalMonths, 36);

  const bad: [string, unknown][] = [
    ['days and months', { name: 'A', intervalDays: 30, intervalMonths: 1 }], ['zero months', { name: 'A', intervalMonths: 0 }], ['huge months', { name: 'A', intervalMonths: 1201 }],
    ['fractional months', { name: 'A', intervalMonths: 1.5 }], ['one-time with months', { name: 'A', recurring: false, intervalMonths: 3, firstDueOn: day(5) }],
    ['one-time with baseline', { name: 'A', recurring: false, firstDueOn: day(5), baselineKind: 'reported', baselineOn: day(-5) }],
    ['baseline kind unknown', { name: 'A', intervalMonths: 6, baselineKind: 'guess', baselineOn: day(-5) }],
    ['baseline without point', { name: 'A', intervalMonths: 6, baselineKind: 'reported' }],
    ['baseline point without kind', { name: 'A', intervalMonths: 6, baselineOn: day(-5) }],
    ['baseline in the future', { name: 'A', intervalMonths: 6, baselineKind: 'reported', baselineOn: day(1) }],
    ['baseline ancient', { name: 'A', intervalMonths: 6, baselineKind: 'reported', baselineOn: '1850-01-01' }],
    ['baseline negative odometer', { name: 'A', intervalMonths: 6, baselineKind: 'tracking', baselineOdometer: { value: '-1', unit: 'km' } }],
    ['reminders string', { name: 'A', intervalMonths: 6, remindersEnabled: 'no' }],
  ];
  for (const [what, b] of bad) assert.equal((await app.call(owner, 'POST', T(v), b)).status, 422, what);
});

test('acceptance 4: one visit with oil and tyre rotation; completing only oil does not reset the other', { skip }, async () => {
  const v = await vehicle();
  const oil = await task(v, { catalogKey: 'oil_change', intervalMonths: 6, baselineKind: 'reported', baselineOn: day(-200) });
  const tyres = await task(v, { catalogKey: 'tyre_rotation', intervalMonths: 6, baselineKind: 'reported', baselineOn: day(-200) });
  assert.equal(oil.status, 'overdue'); assert.equal(tyres.status, 'overdue');
  // One visit, two items, only the oil item is linked to its task.
  const r = await visit(v, { servicedOn: day(-1), items: [{ name: 'Oil change', taskId: oil.id }, { name: 'Tyre rotation' }] });
  assert.equal(r.status, 201, r.text);
  const after = await get(v, oil.id), other = await get(v, tyres.id);
  assert.equal(after.baseline, 'completion'); assert.equal(after.status, 'ok'); assert.equal(after.lastCompleted.servicedOn, day(-1));
  assert.equal(other.baseline, 'reported', 'the unlinked item does not complete the other task'); assert.equal(other.status, 'overdue');
  assert.equal(other.lastCompleted, null);
});

test('acceptance 3 end to end: the next due point follows the actual completion date and odometer', { skip }, async () => {
  const v = await vehicle({ odometerUnit: 'mi' });
  const oil = await task(v, { catalogKey: 'oil_change', intervalMonths: 6, intervalDistance: { value: '5000', unit: 'mi' }, baselineKind: 'reported', baselineOn: day(-60), baselineOdometer: { value: '60000', unit: 'mi' } });
  assert.deepEqual(oil.dueOdometer, { value: '65000', unit: 'mi' });
  await visit(v, { servicedOn: day(-2), odometer: { value: '64200', unit: 'mi' }, items: [{ name: 'Oil', taskId: oil.id }] });
  const t = await get(v, oil.id);
  assert.deepEqual(t.dueOdometer, { value: '69200', unit: 'mi' }, '4200 mi after the previous one: the next one counts from 64200');
  assert.equal(t.dueOn > day(170), true); assert.equal(t.baseline, 'completion');
});

test('reminders switch: tasksNeedingAttention leaves out tasks whose reminders are off; summary counts follow', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'On', intervalMonths: 1, baselineKind: 'reported', baselineOn: day(-60) });
  const off = await task(v, { name: 'Off', intervalMonths: 1, baselineKind: 'reported', baselineOn: day(-60), remindersEnabled: false });
  assert.equal(off.status, 'overdue', 'the in-app status is unchanged by the reminders switch');
  assert.deepEqual((await tasksNeedingAttention(db!.pool, v as Id, owner.id as Id)).map((t) => t.name), ['On']);
  const sum = (await app.call(owner, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json.counts;
  assert.deepEqual([sum.overdue, sum.needsAttention, sum.remindersActive], [2, 2, 1]);
});

test('export and import carry months, baselines, reminders and provenance; a customised preset task is not duplicated', { skip }, async () => {
  const v = await vehicle();
  const made = await task(v, {
    catalogKey: 'brake_fluid', intervalMonths: 36, baselineKind: 'reported', baselineOn: '2024-05-10', baselineOdometer: { value: '81234.5', unit: 'mi' }, remindersEnabled: false,
  });
  await seedProvenance(made.id);
  const t = await get(v, made.id);
  const doc = JSON.parse((await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=json`)).text);
  const ex = doc.maintenanceTasks[0];
  assert.deepEqual(
    { intervalMonths: ex.intervalMonths, presetId: ex.presetId, presetVersion: ex.presetVersion, presetTaskId: ex.presetTaskId, baselineKind: ex.baselineKind, baselineOn: ex.baselineOn,
      baselineOdometer: ex.baselineOdometer, remindersEnabled: ex.remindersEnabled, sourceTrust: ex.sourceTrust, sourceNote: ex.sourceNote },
    { intervalMonths: 36, ...PRESET, baselineKind: 'reported', baselineOn: '2024-05-10', baselineOdometer: { value: '81234.5', unit: 'mi' }, remindersEnabled: false, sourceTrust: 'manufacturer', sourceNote: 'manual' });
  const fresh = await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: doc, dryRun: false });
  assert.equal(fresh.status, 200, fresh.text);
  const nv = fresh.json.vehicle.id as string;
  const [imp] = (await app.call(stranger, 'GET', T(nv))).json.items;
  for (const k of ['intervalMonths', 'presetId', 'presetVersion', 'presetTaskId', 'baselineKind', 'baselineOn', 'baselineOdometer', 'remindersEnabled', 'sourceTrust', 'sourceNote', 'dueOn', 'baseline']) {
    assert.deepEqual(imp[k], t[k], k);
  }
  // The owner customises the imported preset task, then imports the same file again: no duplicate, no overwrite.
  await app.call(stranger, 'PATCH', T(nv, imp.id), { intervalMonths: 24, name: 'Brake fluid flush' });
  const again = await app.call(stranger, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: doc, dryRun: false });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json.maintenanceTasks, { total: 1, created: 0, duplicates: 1, invalid: 0 });
  const kept = (await app.call(stranger, 'GET', T(nv))).json.items;
  assert.equal(kept.length, 1); assert.equal(kept[0].intervalMonths, 24); assert.equal(kept[0].name, 'Brake fluid flush');
  // Files from before this version (no new fields) import with reminders on and no provenance.
  const legacy = { ...doc, maintenanceTasks: [{ ref: 't1', name: 'Old', intervalDays: 30 }], serviceVisits: [] };
  const old = await app.call(stranger, 'POST', '/v1/vehicle-imports', { data: legacy, dryRun: false });
  assert.equal(old.status, 200, old.text);
  const [o] = (await app.call(stranger, 'GET', T(old.json.vehicle.id))).json.items;
  assert.equal(o.remindersEnabled, true); assert.equal(o.presetId, null); assert.equal(o.intervalMonths, null);
});

test('provenance is not writable over the public API; an interval edit drops the trust label, other edits keep it', { skip }, async () => {
  const v = await vehicle();
  const fields: Record<string, unknown> = { presetId: PRESET.presetId, presetVersion: 1, presetTaskId: 'brake-fluid', sourceTrust: 'community', sourceNote: 'note' };
  const plain = await task(v, { name: 'Hand made', intervalMonths: 12 });
  for (const [k, val] of Object.entries(fields)) {
    const post = await app.call(owner, 'POST', T(v), { name: 'X', intervalMonths: 6, [k]: val });
    assert.equal(post.status, 422, `POST ${k}: ${post.text}`);
    const patch = await app.call(owner, 'PATCH', T(v, plain.id), { [k]: val });
    assert.equal(patch.status, 422, `PATCH ${k}: ${patch.text}`);
    assert.equal((await app.call(owner, 'PATCH', T(v, plain.id), { [k]: null })).status, 422, `PATCH ${k} null`);
  }
  const after = await get(v, plain.id);
  assert.deepEqual([after.presetId, after.presetTaskId, after.sourceTrust, after.sourceNote], [null, null, null, null]);

  const t = await task(v, { catalogKey: 'brake_fluid', intervalMonths: 36, intervalDistance: { value: '30000', unit: 'mi' } });
  await seedProvenance(t.id);
  const renamed = await app.call(owner, 'PATCH', T(v, t.id), { name: 'Brake fluid flush' });
  assert.equal(renamed.json.sourceTrust, 'manufacturer', 'a name edit keeps the trust label');
  const same = await app.call(owner, 'PATCH', T(v, t.id), { intervalMonths: 36, intervalDistance: { value: '30000.0', unit: 'mi' } });
  assert.equal(same.json.sourceTrust, 'manufacturer', 'resending the same interval keeps it');
  const changed = await app.call(owner, 'PATCH', T(v, t.id), { intervalMonths: 24 });
  assert.equal(changed.status, 200, changed.text); assert.equal(changed.json.sourceTrust, null);
  assert.deepEqual([changed.json.sourceNote, changed.json.presetId, changed.json.presetVersion, changed.json.presetTaskId], ['manual', PRESET.presetId, 1, 'brake-fluid']);
  const dist = await task(v, { name: 'Dist', intervalDistance: { value: '5000', unit: 'mi' } });
  await seedProvenance(dist.id, { ...PROVENANCE, presetTaskId: 'other' });
  assert.equal((await app.call(owner, 'PATCH', T(v, dist.id), { intervalDistance: { value: '6000', unit: 'mi' } })).json.sourceTrust, null);
});
