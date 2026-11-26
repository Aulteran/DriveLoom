// Community maintenance presets over HTTP: loading (invalid files skipped),
// matching a free-text vehicle, the list annotations, apply (atomic, idempotent,
// reminders off, never touching odometer data or sending anything), preview,
// duplicates, authorization, export/import, and the "no maintenance codes" rule.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { ServiceService } from '../src/service/service.ts';
import { serviceRoutes } from '../src/service/routes.ts';
import { MaintenanceService } from '../src/service/maintenance.ts';
import { maintenanceRoutes } from '../src/service/maintenance-routes.ts';
import { NotificationSettingsService, notificationRoutes } from '../src/service/notification-settings.ts';
import { Notifier } from '../src/service/notifications.ts';
import { PortabilityService } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { setModule } from '../src/modules.ts';
import { MemoryMailer } from '../src/auth/mailer.ts';
import { addDays, addMonths, utcDate } from '../src/service/maintenance-status.ts';
import { bundledPresets, loadPresets, matchPresets, type Preset } from '../src/service/presets.ts';
import { normalizeIdentity, sameIdentity } from '../src/vehicles/model-identity.ts';
import type { Id } from '../src/types.ts';
import { createTestDb, createTestUser, ORIGIN, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const day = (n: number) => addDays(utcDate(new Date()), n);
const ODY = 'us-honda-odyssey-2015';
const ALL = ['engine-oil', 'brake-fluid', 'timing-belt', 'transmission-fluid', 'tire-rotation', 'brake-inspection', 'engine-air-filter', 'cabin-filter', 'drive-belt-inspection', 'engine-coolant', 'spark-plugs', 'water-pump-inspection', 'valve-clearance', 'idle-speed-inspection', 'battery-terminals', 'wiper-blades', 'general-inspection'];
const MANUFACTURER = ['brake-fluid', 'idle-speed-inspection', 'battery-terminals'];
const preset = (over: Partial<Preset> = {}): Preset => ({
  schemaVersion: 1, id: 'us-acme-roadster-2020', version: 1, market: 'us', make: 'acme', model: 'roadster', year: 2020, reviewedOn: '2026-01-01', sources: [],
  tasks: [{ id: 'oil', name: 'Oil', catalogKey: 'oil_change', description: 'd', rule: { months: 12 }, trust: 'community', sourceNote: 'n' }], ...over,
});

// ---------- pure ----------
test('make and model normalisation ignores case, spacing, punctuation and accents', () => {
  assert.equal(normalizeIdentity('  Honda  '), 'honda');
  assert.equal(normalizeIdentity('CR  V'), 'cr-v');
  assert.equal(normalizeIdentity('Cr-V.'), 'cr-v');
  assert.equal(normalizeIdentity('Citroën'), 'citroen');
  assert.equal(normalizeIdentity(null), '');
  assert.ok(sameIdentity('ODYSSEY', 'odyssey'));
  assert.ok(!sameIdentity('', ''), 'empty never matches');
  assert.ok(!sameIdentity('Odyssey EX-L', 'odyssey'), 'no partial matches (aliases come later)');
});

test('matching: market, make, model and year or year range; nothing without all three details', () => {
  const ps = [preset(), preset({ id: 'us-acme-roadster-2018', year: undefined, yearRange: [2018, 2021] }), preset({ id: 'ca-acme-roadster-2020', market: 'ca' })];
  assert.deepEqual(matchPresets(ps, { make: ' ACME', model: 'Roadster ', year: 2020 }, 'us').map((p) => p.id), ['us-acme-roadster-2020', 'us-acme-roadster-2018'], 'both are offered; the owner chooses');
  assert.deepEqual(matchPresets(ps, { make: 'acme', model: 'roadster', year: 2019 }, 'us').map((p) => p.id), ['us-acme-roadster-2018']);
  assert.deepEqual(matchPresets(ps, { make: 'acme', model: 'roadster', year: 2020 }, 'ca').map((p) => p.id), ['ca-acme-roadster-2020']);
  assert.deepEqual(matchPresets(ps, { make: 'acme', model: 'roadster', year: 2022 }, 'us'), []);
  assert.deepEqual(matchPresets(ps, { make: 'acme', model: null, year: 2020 }, 'us'), []);
  assert.deepEqual(matchPresets(ps, { make: 'acme', model: 'roadster', year: null }, 'us'), []);
});

test('loader: the bundled preset loads; invalid files are skipped with a warning, never a crash', async () => {
  assert.deepEqual(bundledPresets().map((p) => p.id), [ODY]);
  const dir = await mkdtemp(join(tmpdir(), 'dl-presets-'));
  try {
    const put = async (rel: string, body: unknown) => { await mkdir(join(dir, rel, '..'), { recursive: true }); await writeFile(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body)); };
    await put('preset.schema.json', { not: 'a preset' });
    await put('us/acme/roadster/2020.json', preset());
    await put('us/acme/roadster/2021.json', '{ nope');
    await put('us/acme/roadster/2022.json', { ...preset({ id: 'us-acme-roadster-2022', year: 2022 }), dashboardCode: 'A1' });
    await put('us/acme/roadster/2023.json', preset({ id: 'us-acme-roadster-2023', year: 2023, tasks: [{ id: 'oil', name: 'Oil', description: 'd', rule: { distance: { value: '5000.1234', unit: 'mi' } }, trust: 'community', sourceNote: 'n' }] }));
    await put('us/acme/roadster/2024.json', preset({ year: 2024 }));
    await put('us/acme/roadster/notes.txt', 'ignored');
    const warnings: string[] = [];
    const got = loadPresets(pathToFileURL(`${dir}/`), (m) => warnings.push(m));
    assert.deepEqual(got.map((p) => p.id), ['us-acme-roadster-2020']);
    assert.equal(warnings.length, 4, warnings.join('\n'));
    assert.match(warnings.join('\n'), /2021\.json: invalid JSON/);
    assert.match(warnings.join('\n'), /2022\.json: .*unknown key "dashboardCode"/);
    assert.match(warnings.join('\n'), /2023\.json: oil: /, 'a value the task API would refuse is caught at load');
    assert.match(warnings.join('\n'), /2024\.json: /);
    const none: string[] = [];
    assert.deepEqual(loadPresets(pathToFileURL(`${dir}/missing/`), (m) => none.push(m)), []);
    assert.equal(none.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- database ----------
let db: TestDb | null, app: TestApp, notifier: Notifier, mailer: MemoryMailer;
let owner: TestUser, editor: TestUser, driver: TestUser, viewer: TestUser, stranger: TestUser;
let svc: MaintenanceService;

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, driver, viewer, stranger] = await Promise.all(Array.from({ length: 5 }, () => createTestUser(db!.pool))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  mailer = new MemoryMailer();
  notifier = new Notifier({ db: db.pool, mailer: () => mailer, publicOrigin: ORIGIN, log: () => undefined });
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles), service = new ServiceService(db.pool, vehicles);
  svc = new MaintenanceService(db.pool, vehicles);
  app = await startApp([owner, editor, driver, viewer, stranger], [
    ...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...serviceRoutes(service), ...maintenanceRoutes(svc), ...preferenceRoutes(db.pool),
    ...notificationRoutes(new NotificationSettingsService(db.pool, vehicles, () => true)), ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel, service)),
  ]);
  await setModule(db.pool, 'service', true);
});
after(async () => { await notifier?.stop(); app?.close(); await db?.drop(); });
afterEach(async () => { if (db) await setModule(db.pool, 'service', true); });

async function vehicle(over: Record<string, unknown> = {}, email = false): Promise<Id> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Van', make: 'Honda', model: 'Odyssey', year: 2015, odometerUnit: 'mi', currency: 'USD', ...over });
  assert.equal(v.status, 201, v.text);
  for (const [u, role] of [[editor, 'editor'], [driver, 'driver'], [viewer, 'viewer']] as const) await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: u.id, role });
  if (email) assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v.json.id}/notification-settings`, { emailEnabled: true, followUpDays: 7, recipientUserIds: [] })).status, 200);
  return v.json.id;
}
const P = (v: Id, q = '') => `/v1/vehicles/${v}/maintenance/presets${q}`;
const A = (v: Id, id = ODY, preview = false) => `/v1/vehicles/${v}/maintenance/presets/${id}/apply${preview ? '?preview=true' : ''}`;
const T = (v: Id, id = '') => `/v1/vehicles/${v}/maintenance-tasks${id ? `/${id}` : ''}`;
const sel = (ids = ALL, extra: Record<string, unknown> = {}) => ids.map((presetTaskId) => ({ presetTaskId, ...extra }));
async function apply(v: Id, body: unknown, as: TestUser = owner, preview = false) {
  const r = await app.call(as, 'POST', A(v, ODY, preview), body);
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const tasks = async (v: Id) => (await app.call(owner, 'GET', `${T(v)}?includeArchived=true`)).json.items as any[];
const byPreset = (ts: any[], id: string) => ts.find((t) => t.presetTaskId === id);
const visit = async (v: Id, body: Record<string, unknown>) => { const r = await app.call(owner, 'POST', `/v1/vehicles/${v}/service-visits`, body); assert.equal(r.status, 201, r.text); return r.json; };
const counts = async (v: Id) => (await db!.pool.query<{ f: number; s: number; o: number; l: number }>(
  `SELECT (SELECT count(*)::int FROM fill_ups WHERE vehicle_id = $1) AS f, (SELECT count(*)::int FROM service_visits WHERE vehicle_id = $1) AS s,
          (SELECT count(*)::int FROM notification_outbox WHERE vehicle_id = $1) AS o, (SELECT count(*)::int FROM notification_task_log WHERE vehicle_id = $1) AS l`, [v])).rows[0]!;
const code = (r: { json: any }) => r.json.code ?? r.json.type?.split('/').pop();

test('list: a matching vehicle sees the preset with trust labels; others see nothing and keep the manual workflow', { skip }, async () => {
  const v = await vehicle({ make: '  HONDA', model: 'odyssey ' });
  const r = await app.call(viewer, 'GET', P(v));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.market, 'us'); assert.deepEqual(r.json.missing, []); assert.equal(r.json.canApply, false, 'viewers read only');
  assert.equal(r.json.items.length, 1);
  const p = r.json.items[0];
  assert.equal(p.id, ODY); assert.deepEqual(p.needsQualifier, []);
  assert.deepEqual(p.tasks.map((t: any) => t.id), ALL);
  assert.ok(p.tasks.every((t: any) => t.trust === (MANUFACTURER.includes(t.id) ? 'manufacturer' : 'community') && t.alreadyImported === null && t.existingTaskMatch === null));
  assert.deepEqual(p.tasks[0].rule, { months: 6, distance: { value: '5000', unit: 'mi' } });
  assert.equal((await app.call(owner, 'GET', P(v))).json.canApply, true);

  const other = await vehicle({ make: 'Toyota', model: 'Sienna' });
  assert.deepEqual((await app.call(owner, 'GET', P(other))).json.items, []);
  const noYear = await vehicle({ year: null });
  const ny = (await app.call(owner, 'GET', P(noYear))).json;
  assert.deepEqual(ny.items, []); assert.deepEqual(ny.missing, ['year'], 'ask the owner instead of guessing');
  assert.deepEqual((await app.call(owner, 'GET', P(v, '?market=ca'))).json.items, [], 'another market has no presets');
  assert.equal((await app.call(owner, 'GET', P(v, '?market=US!'))).status, 422);
  assert.equal((await app.call(stranger, 'GET', P(v))).status, 404);
  assert.equal((await app.call(null, 'GET', P(v))).status, 401);
  // Applying to a vehicle the preset does not match is refused.
  const no = await app.call(owner, 'POST', A(other), { tasks: sel() });
  assert.equal(no.status, 422); assert.equal(code(no), 'maintenance_preset_not_applicable');
  assert.equal((await tasks(other)).length, 0);
});

test('acceptance 1: no history -> tasks imported needing a baseline, nothing overdue, no emails, no odometer writes', { skip }, async () => {
  const v = await vehicle({}, true);
  await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(-2)}T08:00:00Z`, odometer: { value: '120000', unit: 'mi' }, volume: { value: '10', unit: 'gal_us' } });
  const before = await counts(v);
  const r = await apply(v, { tasks: sel() });
  assert.equal(r.preview, false);
  assert.deepEqual(r.results.map((x: any) => x.result), ALL.map(() => 'created'));
  assert.ok(r.results.every((x: any) => x.status === 'no_baseline' && x.baseline === 'none' && x.dueOn === null && x.remindersEnabled === false));
  assert.deepEqual(r.reading.odometer, { value: '120000', unit: 'mi' });
  const ts = await tasks(v);
  assert.equal(ts.length, ALL.length);
  for (const t of ts) {
    assert.equal(t.status, 'no_baseline'); assert.equal(t.needsAttention, false);
    assert.equal(t.presetId, ODY); assert.equal(t.presetVersion, 2); assert.equal(t.remindersEnabled, false); assert.equal(t.sourceTrust, MANUFACTURER.includes(t.presetTaskId) ? 'manufacturer' : 'community');
    assert.ok(t.sourceNote.length > 0); assert.equal(t.notes, null); assert.equal(t.createdBy, owner.id);
  }
  assert.equal(byPreset(ts, 'engine-oil').intervalMonths, 6);
  assert.deepEqual(byPreset(ts, 'engine-oil').intervalDistance, { value: '5000', unit: 'mi' });
  assert.equal(byPreset(ts, 'engine-oil').catalogKey, 'oil_change');
  assert.equal(byPreset(ts, 'transmission-fluid').catalogKey, null);
  assert.equal((await notifier.evaluateVehicle(v, new Date())).enqueued, 0);
  const afterCounts = await counts(v);
  assert.deepEqual(afterCounts, { ...before, o: 0, l: 0 }, 'no fill-ups, visits, outbox or ledger rows were added');
  const audit = (await db!.pool.query("SELECT details FROM audit_events WHERE subject_id = $1 AND action = 'maintenance_preset.apply'", [v])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].details.presetId, ODY); assert.equal(audit[0].details.results.length, ALL.length);
});

test('acceptance 2/3/5 via apply: reported baselines, a linked visit, then a real completion moves the due point', { skip }, async () => {
  const v = await vehicle();
  const oldVisit = await visit(v, { servicedOn: day(-200), odometer: { value: '40000', unit: 'mi' }, items: [{ name: 'Oil change' }, { name: 'Wipers' }] });
  const noOdo = await visit(v, { servicedOn: day(-150), items: [{ name: 'Transmission fluid' }] });
  // GET suggests the matching unlinked items, never links them.
  const list = (await app.call(owner, 'GET', P(v))).json.items[0].tasks;
  assert.deepEqual(list.find((t: any) => t.id === 'engine-oil').suggestedServiceItems.map((i: any) => i.id), [oldVisit.items[0].id]);
  assert.deepEqual(list.find((t: any) => t.id === 'transmission-fluid').suggestedServiceItems.map((i: any) => i.id), [noOdo.items[0].id]);
  assert.deepEqual(list.find((t: any) => t.id === 'brake-fluid').suggestedServiceItems, []);

  const r = await apply(v, { tasks: [
    { presetTaskId: 'engine-oil', baseline: { kind: 'reported', linkServiceItemId: oldVisit.items[0].id } },
    { presetTaskId: 'brake-fluid', baseline: { kind: 'reported', on: '2024-05-10' } },
    { presetTaskId: 'timing-belt', baseline: { kind: 'reported', on: day(-30), odometer: { value: '90000', unit: 'mi' } } },
    { presetTaskId: 'transmission-fluid', baseline: { kind: 'reported', linkServiceItemId: noOdo.items[0].id } },
  ] });
  const res = (id: string) => r.results.find((x: any) => x.presetTaskId === id);
  assert.equal(res('engine-oil').baseline, 'completion'); assert.equal(res('engine-oil').baselineKind, null, 'the link is the completion; no extra baseline stored');
  assert.deepEqual(res('engine-oil').dueOdometer, { value: '45000', unit: 'mi' }); assert.equal(res('engine-oil').dueOn, addMonths(day(-200), 6));
  assert.equal(res('brake-fluid').dueOn, '2027-05-10'); assert.equal(res('brake-fluid').baseline, 'reported');
  assert.deepEqual(res('timing-belt').dueOdometer, { value: '190000', unit: 'mi' }); assert.equal(res('timing-belt').dueOn, addMonths(day(-30), 84));
  // Acceptance 5: a completion without odometer leaves the distance side unknown; the reading used is shown with its date.
  assert.equal(res('transmission-fluid').distanceBaselineMissing, true); assert.equal(res('transmission-fluid').dueOdometer, null);
  assert.equal(res('transmission-fluid').dueOn, addMonths(day(-150), 36));
  assert.deepEqual(r.reading, { odometer: { value: '40000', unit: 'mi' }, on: day(-200), source: 'service', stale: true });
  assert.equal(res('engine-oil').readingStale, true);
  assert.equal((await db!.pool.query('SELECT task_id FROM service_items WHERE id = $1', [oldVisit.items[1].id])).rows[0].task_id, null, 'only the chosen item is linked');

  // Acceptance 3: oil completed 4,200 mi after the previous one -> thresholds from the actual new completion.
  const oil = res('engine-oil').taskId;
  await visit(v, { servicedOn: day(-20), odometer: { value: '44200', unit: 'mi' }, items: [{ name: 'Oil change', taskId: oil }, { name: 'Tire rotation' }] });
  const t = (await app.call(owner, 'GET', T(v, oil))).json;
  assert.deepEqual(t.dueOdometer, { value: '49200', unit: 'mi' }); assert.equal(t.dueOn, addMonths(day(-20), 6)); assert.equal(t.status, 'ok');
  assert.equal((await app.call(owner, 'GET', T(v, res('brake-fluid').taskId))).json.dueOn, '2027-05-10', 'other tasks are not reset by that visit');
});

test('tracking baseline: today plus a recent reading, never shown as up to date', { skip }, async () => {
  const v = await vehicle();
  await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(-3)}T08:00:00Z`, odometer: { value: '100000', unit: 'mi' }, volume: { value: '10', unit: 'gal_us' } });
  const before = await counts(v);
  const r = await apply(v, { tasks: sel(['engine-oil', 'brake-fluid'], { baseline: { kind: 'tracking' } }) });
  for (const x of r.results) { assert.equal(x.baseline, 'tracking'); assert.equal(x.status, 'no_baseline', 'a tracking point is not a completion'); }
  const ts = await tasks(v);
  assert.equal(byPreset(ts, 'engine-oil').baselineOn, day(0));
  assert.deepEqual(byPreset(ts, 'engine-oil').baselineOdometer, { value: '100000', unit: 'mi' });
  assert.deepEqual(byPreset(ts, 'engine-oil').dueOdometer, { value: '105000', unit: 'mi' });
  assert.deepEqual(await counts(v), before, 'the reading is copied, never written');
});

test('preview: same validation and statuses, nothing stored', { skip }, async () => {
  const v = await vehicle();
  const r = await apply(v, { tasks: [{ presetTaskId: 'brake-fluid', baseline: { kind: 'reported', on: '2024-01-31' }, overrides: { intervalMonths: 1 } }, { presetTaskId: 'engine-oil' }] }, owner, true);
  assert.equal(r.preview, true);
  assert.equal(r.results[0].result, 'created'); assert.equal(r.results[0].taskId, null);
  assert.equal(r.results[0].dueOn, '2024-02-29', 'month-end clamping'); assert.equal(r.results[0].status, 'overdue');
  assert.equal(r.results[0].sourceTrust, null, 'an owner-edited interval loses the trust label');
  assert.equal(r.results[1].status, 'no_baseline');
  assert.equal((await tasks(v)).length, 0);
  assert.equal((await db!.pool.query("SELECT 1 FROM audit_events WHERE subject_id = $1 AND action = 'maintenance_preset.apply'", [v])).rowCount, 0);
  const bad = await app.call(owner, 'POST', A(v, ODY, true), { tasks: [{ presetTaskId: 'brake-fluid', baseline: { kind: 'reported', on: day(5) } }] });
  assert.equal(bad.status, 422, 'a preview validates like an apply');
  assert.equal((await app.call(owner, 'POST', `${A(v)}?preview=maybe`, { tasks: sel() })).status, 422);
});

test('acceptance 6: re-applying with customised intervals and linked history -> no duplicate, no overwrite, nothing deleted', { skip }, async () => {
  const v = await vehicle();
  const first = await apply(v, { tasks: sel() });
  const oil = first.results[0].taskId as Id, trans = first.results[3].taskId as Id;
  assert.equal((await app.call(owner, 'PATCH', T(v, oil), { intervalMonths: 12, notes: 'mine' })).status, 200);
  await visit(v, { servicedOn: day(-10), odometer: { value: '50000', unit: 'mi' }, items: [{ name: 'Oil', taskId: oil }] });
  await app.call(owner, 'PATCH', T(v, trans), { archived: true });
  const snapshot = await tasks(v);

  const list = (await app.call(owner, 'GET', P(v))).json.items[0].tasks;
  assert.ok(list.every((t: any) => t.alreadyImported !== null && t.existingTaskMatch === null));
  assert.equal(list[3].alreadyImported.archived, true);

  const again = await apply(v, { tasks: sel(ALL, { overrides: { intervalMonths: 3 }, baseline: { kind: 'tracking' }, onDuplicate: 'link' }) });
  assert.deepEqual(again.results.map((x: any) => [x.result, x.reason]), ALL.map(() => ['skipped', 'already_imported']));
  assert.equal(again.results[0].taskId, oil);
  const now = await tasks(v);
  assert.equal(now.length, ALL.length);
  assert.deepEqual(now.map((t) => ({ ...t, updatedAt: null })), snapshot.map((t) => ({ ...t, updatedAt: null })), 'nothing changed');
  assert.equal(byPreset(now, 'engine-oil').intervalMonths, 12); assert.equal(byPreset(now, 'engine-oil').lastCompleted.servicedOn, day(-10));
});

test('similar typed-in task: reported in the list, skipped by default, or linked keeping all its settings', { skip }, async () => {
  const v = await vehicle();
  const mine = (await app.call(owner, 'POST', T(v), { name: 'Oil', catalogKey: 'oil_change', intervalDays: 200, notes: 'synthetic' })).json;
  await app.call(owner, 'PUT', `${T(v, mine.id)}/snooze?scope=vehicle`, { until: day(30) });
  const trans = (await app.call(owner, 'POST', T(v), { name: '  transmission   FLUID ', intervalMonths: 24 })).json;
  const before = (await app.call(owner, 'GET', T(v, mine.id))).json;

  const list = (await app.call(owner, 'GET', P(v))).json.items[0].tasks;
  assert.deepEqual(list[0].existingTaskMatch, { taskId: mine.id, name: 'Oil', matchedBy: 'catalogKey' });
  assert.deepEqual(list[3].existingTaskMatch, { taskId: trans.id, name: 'transmission   FLUID', matchedBy: 'name' });

  const skipped = await apply(v, { tasks: sel(['engine-oil', 'transmission-fluid']) });
  assert.deepEqual(skipped.results.map((x: any) => [x.result, x.reason, x.taskId]), [['skipped', 'existing_task', mine.id], ['skipped', 'existing_task', trans.id]]);
  assert.equal((await tasks(v)).length, 2);

  const linked = await apply(v, { tasks: [{ presetTaskId: 'engine-oil', onDuplicate: 'link', overrides: { intervalMonths: 1 }, baseline: { kind: 'tracking' } }] });
  assert.deepEqual(linked.results.map((x: any) => [x.result, x.taskId]), [['linked', mine.id]]);
  const after = (await app.call(owner, 'GET', T(v, mine.id))).json;
  assert.equal(after.presetId, ODY); assert.equal(after.presetTaskId, 'engine-oil'); assert.equal(after.presetVersion, 2);
  const keep = (t: any) => ({ ...t, presetId: null, presetVersion: null, presetTaskId: null, updatedAt: null });
  assert.deepEqual(keep(after), keep(before), 'interval, baseline, reminders, labels, notes and snoozes unchanged');
  assert.equal(after.remindersEnabled, true); assert.equal(after.sourceTrust, null); assert.equal(after.snoozed.scope, 'vehicle');
  const again = await apply(v, { tasks: sel(['engine-oil'], { onDuplicate: 'link' }) });
  assert.deepEqual(again.results.map((x: any) => x.reason), ['already_imported']);
});

test('acceptance 7: imported reminders stay off until a separate opt-in; other tasks unaffected; no catch-up', { skip }, async () => {
  const v = await vehicle({}, true);
  const manual = (await app.call(owner, 'POST', T(v), { name: 'Wipers', catalogKey: 'wipers', recurring: false, firstDueOn: day(-5) })).json;
  const manualBefore = (await app.call(owner, 'GET', T(v, manual.id))).json;
  const r = await apply(v, { tasks: [{ presetTaskId: 'brake-fluid', baseline: { kind: 'reported', on: '2020-01-01' } }] });
  const brake = r.results[0].taskId as Id;
  assert.equal(r.results[0].status, 'overdue'); assert.equal(r.results[0].remindersEnabled, false);
  assert.deepEqual((await app.call(owner, 'GET', T(v, manual.id))).json, manualBefore, 'the other task is untouched');
  assert.equal((await db!.pool.query('SELECT 1 FROM notification_task_log WHERE task_id = $1', [brake])).rowCount, 0);

  await notifier.evaluateVehicle(v, new Date());
  const ob = (await db!.pool.query<{ payload: any }>('SELECT payload FROM notification_outbox WHERE vehicle_id = $1', [v])).rows;
  assert.equal(ob.length, 1);
  assert.deepEqual(ob[0]!.payload.tasks.map((t: any) => t.taskId), [manual.id], 'only the task with reminders on is emailed');

  assert.equal((await app.call(owner, 'PATCH', T(v, brake), { remindersEnabled: true })).status, 200);
  await notifier.evaluateVehicle(v, new Date());
  assert.equal((await db!.pool.query('SELECT 1 FROM notification_outbox WHERE vehicle_id = $1', [v])).rowCount, 1, 'opting in sends no backlog');
  await db!.pool.query("UPDATE notification_outbox SET status = 'cancelled' WHERE vehicle_id = $1 AND status IN ('pending', 'sending')", [v]);
  await db!.pool.query('UPDATE vehicle_notification_settings SET email_enabled = false WHERE vehicle_id = $1', [v]);
});

test('authorization: owners and editors apply; drivers and viewers cannot; archived vehicles and a disabled module block it', { skip }, async () => {
  const v = await vehicle();
  for (const u of [driver, viewer]) {
    const r = await app.call(u, 'POST', A(v), { tasks: sel() });
    assert.equal(r.status, 403, r.text);
    assert.equal((await app.call(u, 'POST', A(v, ODY, true), { tasks: sel() })).status, 403, 'preview is a write check too');
  }
  assert.equal((await app.call(stranger, 'POST', A(v), { tasks: sel() })).status, 404);
  assert.equal((await tasks(v)).length, 0);
  assert.equal((await app.call(editor, 'POST', A(v), { tasks: sel(['engine-oil']) })).status, 200);

  await setModule(db!.pool, 'service', false);
  for (const [m, p, b] of [['GET', P(v)], ['POST', A(v), { tasks: sel() }]] as const) {
    const r = await app.call(owner, m, p, b);
    assert.equal(r.status, 404); assert.equal(code(r), 'module_disabled');
  }
  await setModule(db!.pool, 'service', true);
  await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true });
  assert.equal((await app.call(owner, 'POST', A(v), { tasks: sel() })).status, 409);
  const l = (await app.call(owner, 'GET', P(v))).json;
  assert.equal(l.canApply, false); assert.equal(l.items.length, 1);
  assert.equal((await tasks(v)).length, 1);
});

test('validation: unknown preset or task, bad baselines and overrides', { skip }, async () => {
  const v = await vehicle();
  const r404 = await app.call(owner, 'POST', A(v, 'us-honda-odyssey-1999'), { tasks: sel() });
  assert.equal(r404.status, 404); assert.equal(code(r404), 'maintenance_preset_not_found');
  const bad: [string, unknown][] = [
    ['no tasks', { tasks: [] }], ['not a list', { tasks: 'all' }], ['unknown field', { tasks: sel(), extra: 1 }], ['unknown task', { tasks: [{ presetTaskId: 'coolant' }] }],
    ['twice', { tasks: sel(['engine-oil', 'engine-oil']) }], ['bad kind', { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'guess' } }] }],
    ['reported with nothing', { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'reported' } }] }],
    ['tracking with a date', { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'tracking', on: day(-1) } }] }],
    ['future date', { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'reported', on: day(3) } }] }],
    ['odometer number', { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'reported', odometer: { value: 5, unit: 'mi' } } }] }],
    ['no interval left', { tasks: [{ presetTaskId: 'brake-fluid', overrides: { intervalMonths: null } }] }],
    ['bad months', { tasks: [{ presetTaskId: 'brake-fluid', overrides: { intervalMonths: 0 } }] }],
    ['bad override field', { tasks: [{ presetTaskId: 'brake-fluid', overrides: { intervalDays: 30 } }] }],
    ['bad onDuplicate', { tasks: [{ presetTaskId: 'brake-fluid', onDuplicate: 'replace' }] }],
    ['variant on a preset without variants', { variant: 'EX', tasks: sel() }],
    ['bad link id', { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'reported', linkServiceItemId: 'x' } }] }],
  ];
  for (const [what, b] of bad) assert.equal((await app.call(owner, 'POST', A(v), b)).status, 422, what);
  assert.equal((await tasks(v)).length, 0);
  // Overrides that keep an interval are fine: distance only.
  const ok = await apply(v, { tasks: [{ presetTaskId: 'engine-oil', overrides: { intervalMonths: null, intervalDistance: { value: '7500', unit: 'mi' } } }] });
  const t = (await app.call(owner, 'GET', T(v, ok.results[0].taskId))).json;
  assert.equal(t.intervalMonths, null); assert.deepEqual(t.intervalDistance, { value: '7500', unit: 'mi' }); assert.equal(t.sourceTrust, null); assert.equal(t.presetId, ODY);
});

test('atomic: a task failing after others were inserted rolls back the whole apply', { skip }, async () => {
  const v = await vehicle();
  const other = await vehicle();
  const foreign = await visit(other, { servicedOn: day(-5), items: [{ name: 'Brake fluid' }] });
  const mine = await visit(v, { servicedOn: day(-5), items: [{ name: 'Brake fluid' }, { name: 'Oil' }] });
  const r = await app.call(owner, 'POST', A(v), { tasks: [{ presetTaskId: 'engine-oil' }, { presetTaskId: 'timing-belt', baseline: { kind: 'tracking' } },
    { presetTaskId: 'brake-fluid', baseline: { kind: 'reported', linkServiceItemId: foreign.items[0].id } }] });
  assert.equal(r.status, 422, r.text); assert.match(r.json.detail, /tasks\[2\]\.baseline\.linkServiceItemId/);
  assert.equal((await tasks(v)).length, 0, 'the first two tasks were rolled back');
  // The same item twice, or an item already linked to a task, is refused too.
  const twice = await app.call(owner, 'POST', A(v), { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'reported', linkServiceItemId: mine.items[1].id } },
    { presetTaskId: 'brake-fluid', baseline: { kind: 'reported', linkServiceItemId: mine.items[1].id } }] });
  assert.equal(twice.status, 422);
  const t = (await app.call(owner, 'POST', T(v), { name: 'Typed', intervalDays: 30 })).json;
  await db!.pool.query('UPDATE service_items SET task_id = $1 WHERE id = $2', [t.id, mine.items[0].id]);
  assert.equal((await app.call(owner, 'POST', A(v), { tasks: [{ presetTaskId: 'brake-fluid', baseline: { kind: 'reported', linkServiceItemId: mine.items[0].id } }] })).status, 422);
  assert.equal((await tasks(v)).length, 1);
  assert.equal((await db!.pool.query('SELECT task_id FROM service_items WHERE id = $1', [foreign.items[0].id])).rows[0].task_id, null);
});

test('variants and overlapping presets: listed for the owner to choose, never guessed', { skip }, async () => {
  const vs = new VehicleService(db!.pool);
  const s2 = new MaintenanceService(db!.pool, vs, () => new Date(), [
    preset({ id: 'us-honda-odyssey-2015', make: 'honda', model: 'odyssey', year: 2015, variants: ['EX', 'Touring'] }),
    preset({ id: 'us-honda-odyssey-2014', make: 'honda', model: 'odyssey', year: undefined, yearRange: [2014, 2017] }),
  ]);
  const v = await vehicle();
  const l = await s2.presets(owner.principal, v, undefined);
  assert.deepEqual(l.items.map((p) => [p.id, p.needsQualifier]), [['us-honda-odyssey-2015', ['EX', 'Touring']], ['us-honda-odyssey-2014', []]]);
  await assert.rejects(s2.applyPreset(owner.principal, v, 'us-honda-odyssey-2015', { tasks: sel(['oil']) }, false), (e: any) => e.status === 422 && e.code === 'maintenance_preset_variant_required');
  await assert.rejects(s2.applyPreset(owner.principal, v, 'us-honda-odyssey-2015', { variant: 'LX', tasks: sel(['oil']) }, false), (e: any) => e.status === 422);
  const ok = await s2.applyPreset(owner.principal, v, 'us-honda-odyssey-2015', { variant: 'Touring', tasks: sel(['oil']) }, false);
  assert.equal(ok.variant, 'Touring'); assert.equal(ok.results[0]!['result'], 'created');
  const other = await s2.applyPreset(owner.principal, v, 'us-honda-odyssey-2014', { tasks: sel(['oil']) }, false);
  // Only tasks without provenance count as similar: a task made from another preset is that preset's, so this one is created alongside it.
  assert.deepEqual([other.results[0]!['result'], other.results[0]!['reason']], ['created', null]);
});

test('export and import carry imported tasks; the new vehicle sees them as already imported', { skip }, async () => {
  const v = await vehicle();
  await apply(v, { tasks: [{ presetTaskId: 'brake-fluid', baseline: { kind: 'reported', on: '2024-05-10' } }, { presetTaskId: 'engine-oil', baseline: { kind: 'reported', odometer: { value: '60000', unit: 'mi' } } }] });
  const doc = JSON.parse((await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=json`)).text);
  const fresh = await app.call(owner, 'POST', '/v1/vehicle-imports', { data: doc, dryRun: false });
  assert.equal(fresh.status, 200, fresh.text);
  const nv = fresh.json.vehicle.id as Id;
  const strip = (t: any) => ({ ...t, id: null, vehicleId: null, createdAt: null, updatedAt: null });
  assert.deepEqual((await tasks(nv)).map(strip), (await tasks(v)).map(strip));
  const brake = byPreset(await tasks(nv), 'brake-fluid');
  assert.equal(brake.remindersEnabled, false); assert.equal(brake.dueOn, '2027-05-10'); assert.equal(brake.sourceTrust, 'manufacturer');
  const list = (await app.call(owner, 'GET', P(nv))).json.items[0].tasks;
  assert.deepEqual(list.map((t: any) => t.alreadyImported !== null), [true, true, false, false]);
  const again = await app.call(owner, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: doc, dryRun: false });
  assert.equal(again.json.maintenanceTasks.duplicates, 2);
  assert.equal((await apply(nv, { tasks: sel(['brake-fluid']) })).results[0].reason, 'already_imported');
});

test('a hand-made task cannot claim a presetTaskId, so a real apply still imports it', { skip }, async () => {
  const v = await vehicle();
  const claim = await app.call(owner, 'POST', T(v), { name: 'Coolant', intervalMonths: 36, presetId: ODY, presetVersion: 1, presetTaskId: 'brake-fluid', sourceTrust: 'manufacturer' });
  assert.equal(claim.status, 422, claim.text);
  const mine = await app.call(owner, 'POST', T(v), { name: 'Coolant', intervalMonths: 36 });
  assert.equal(mine.status, 201, mine.text);
  assert.equal((await app.call(owner, 'PATCH', T(v, mine.json.id), { presetId: ODY, presetVersion: 1, presetTaskId: 'brake-fluid' })).status, 422);
  const r = await apply(v, { tasks: sel(['brake-fluid']) });
  assert.equal(r.results[0].result, 'created', JSON.stringify(r.results[0]));
  const made = byPreset(await tasks(v), 'brake-fluid');
  assert.ok(made); assert.equal(made.presetId, ODY); assert.notEqual(made.id, mine.json.id);
  assert.equal((await tasks(v)).length, 2);
});

test('acceptance 8: no maintenance-code or dashboard-code vocabulary anywhere in the product', async () => {
  const root = new URL('../../../', import.meta.url);
  const TEXT = /\.(ts|js|mjs|json|yaml|yml|html|css|md|sql|webmanifest)$/;
  const files: URL[] = [];
  async function walk(u: URL): Promise<void> {
    for (const e of await readdir(u, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const c = new URL(e.name + (e.isDirectory() ? '/' : ''), u);
      if (e.isDirectory()) await walk(c); else if (TEXT.test(e.name)) files.push(c);
    }
  }
  for (const d of ['apps/api/src/', 'apps/web/', 'apps/api/maintenance-presets/']) await walk(new URL(d, root));
  // The contributor README states the rule ("no ... codes") in words; the data files themselves are what is checked there.
  const scanned = files.filter((f) => !(f.pathname.includes('/maintenance-presets/') && f.pathname.endsWith('.md')));
  files.length = 0; files.push(...scanned);
  files.push(new URL('apps/api/openapi/openapi.yaml', root));
  assert.ok(files.length > 50);
  const bad = [/(?<!re)minder/i, /dashboard[\s_-]*code/i, /maintenance[\s_-]*code/i, /service[\s_-]*code/i, /oil[\s_-]*life/i, /sub[\s_-]*code/i];
  const hits: string[] = [];
  for (const f of files) {
    if ((await stat(f)).size > 2_000_000) continue;
    const text = await readFile(f, 'utf8');
    for (const re of bad) if (re.test(text)) hits.push(`${f.pathname.split('/apps/')[1]}: ${re}`);
    // In preset files, also no code-like tokens such as A1 or B12.
    if (f.pathname.includes('/maintenance-presets/') && f.pathname.endsWith('.json') && /"[AB]\d{1,2}"|\b[AB]\d{1,2}\b/.test(text)) hits.push(`${f.pathname}: code-like token`);
  }
  assert.deepEqual(hits, []);
});
