// Maintenance reminder emails: rules (pure), the evaluator and outbox against a
// real database with a fake mailer (never real SMTP), and the settings API.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { ServiceService } from '../src/service/service.ts';
import { serviceRoutes } from '../src/service/routes.ts';
import { MaintenanceService } from '../src/service/maintenance.ts';
import { maintenanceRoutes } from '../src/service/maintenance-routes.ts';
import { NotificationSettingsService, notificationRoutes } from '../src/service/notification-settings.ts';
import {
  DEFAULT_FOLLOW_UP_DAYS, MAX_ATTEMPTS, Notifier, RETRY_BASE_MS, followUpBucket, occurrenceKey, recipientsOf, redactError, renderEmail, retryDelayMs,
} from '../src/service/notifications.ts';
import { withOdometerTrigger } from '../src/application.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { setModule } from '../src/modules.ts';
import { MemoryMailer, type Mailer } from '../src/auth/mailer.ts';
import { addDays, utcDate } from '../src/service/maintenance-status.ts';
import { canManageNotifications, canReceiveServiceEmail } from '../src/vehicles/permissions.ts';
import type { Role } from '../src/vehicles/types.ts';
import type { Id } from '../src/types.ts';
import { createTestDb, createTestUser, ORIGIN, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const DAY = 86_400_000;
const day = (n: number) => addDays(utcDate(new Date()), n);
const at = (n: number) => new Date(Date.now() + n * DAY);

// ---------- pure rules ----------
test('permission helpers: owner, editor and driver can receive; owner and editor manage', () => {
  const roles: Role[] = ['owner', 'editor', 'driver', 'viewer'];
  assert.deepEqual(roles.map(canReceiveServiceEmail), [true, true, true, false]);
  assert.deepEqual(roles.map(canManageNotifications), [true, true, false, false]);
});

test('occurrence, follow-up buckets and backoff', () => {
  assert.equal(occurrenceKey({ dueOn: '2026-01-01', dueOdometer: null }), '2026-01-01|-');
  assert.equal(occurrenceKey({ dueOn: null, dueOdometer: { value: '15000' as never, unit: 'km' } }), '-|15000km');
  const t0 = new Date('2026-01-01T00:00:00Z');
  assert.equal(followUpBucket(t0, new Date(t0.getTime() + 6.9 * DAY), 7), 0);
  assert.equal(followUpBucket(t0, new Date(t0.getTime() + 7 * DAY), 7), 1);
  assert.equal(followUpBucket(t0, new Date(t0.getTime() + 15 * DAY), 7), 2);
  assert.equal(followUpBucket(t0, new Date(t0.getTime() + 365 * DAY), 0), 0, 'no follow-ups');
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [RETRY_BASE_MS, 2 * RETRY_BASE_MS, 4 * RETRY_BASE_MS, 8 * RETRY_BASE_MS]);
  assert.equal(DEFAULT_FOLLOW_UP_DAYS, 7);
});

test('errors are stored without credentials', () => {
  const e = Object.assign(new Error('connect to smtp://mailer:hunter2@mail.example.test failed\r\npassword=hunter2'), { code: 'ECONNREFUSED' });
  const r = redactError(e);
  assert.ok(!r.includes('hunter2'), r);
  assert.ok(r.startsWith('ECONNREFUSED: '), r);
  assert.ok(!/[\r\n]/.test(r));
  assert.ok(redactError(new Error('x'.repeat(1000))).length <= 300);
});

test('email text and HTML: grouped tasks, escaped, link, opt-out footer and safety wording', () => {
  const m = renderEmail('Bob\'s <Car>', [
    { taskId: 'a' as Id, name: 'Oil & <b>filter</b>', status: 'overdue', occurrence: 'x', dueOn: '2026-01-01', dueOdometer: { value: '15000', unit: 'km' } },
    { taskId: 'b' as Id, name: 'Wipers', status: 'due_soon', occurrence: 'y', dueOn: '2026-02-01', dueOdometer: null },
  ], { value: '15200', unit: 'km', on: '2026-01-05' }, 'https://dl.test/#/vehicles/v/service?view=maintenance');
  assert.match(m.subject, /overdue/); assert.match(m.subject, /2 tasks/);
  assert.match(m.text, /- Oil & <b>filter<\/b>: overdue\n {2}Due on 2026-01-01 or at 15,000 km\./);
  assert.match(m.text, /- Wipers: due soon/);
  assert.match(m.text, /Latest known odometer: 15,200 km, recorded on 2026-01-05\./);
  assert.match(m.text, /Open the Service page: https:\/\/dl\.test\//);
  assert.match(m.text, /turn off "Email me about this vehicle"/);
  assert.match(m.text, /Snoozing a task only mutes its reminders/);
  assert.match(m.text, /not a substitute for your manufacturer's schedule or a mechanic's advice/);
  assert.ok(m.html.includes('Oil &amp; &lt;b&gt;filter&lt;/b&gt;'));
  assert.ok(m.html.includes('Bob&#39;s &lt;Car&gt;'));
  assert.ok(!m.html.includes('<b>filter'), 'no markup from data');
  assert.ok(m.html.includes('href="https://dl.test/#/vehicles/v/service?view=maintenance"'));
  assert.ok(!renderEmail('X', [], null, null).text.includes('Open the Service page'), 'no link without a public origin');
  assert.ok(!/[\r\n]/.test(renderEmail('A\r\nBcc: x@y', [], null, null).subject), 'no header injection through the subject');
});

// ---------- database ----------
let db: TestDb | null, app: TestApp;
let owner: TestUser, editor: TestUser, driver: TestUser, viewer: TestUser, stranger: TestUser;
let mailer: MemoryMailer, smtpOn = true, logs: string[] = [];
let notifier: Notifier;
let mailerImpl: () => Mailer | null = () => (smtpOn ? mailer : null);

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, driver, viewer, stranger] = await Promise.all(Array.from({ length: 5 }, () => createTestUser(db!.pool))) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  mailer = new MemoryMailer();
  notifier = new Notifier({ db: db.pool, mailer: () => mailerImpl(), publicOrigin: ORIGIN, log: (m) => logs.push(m) });
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles), service = new ServiceService(db.pool, vehicles);
  app = await startApp([owner, editor, driver, viewer, stranger], withOdometerTrigger([
    ...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...serviceRoutes(service), ...maintenanceRoutes(new MaintenanceService(db.pool, vehicles)), ...preferenceRoutes(db.pool),
    ...notificationRoutes(new NotificationSettingsService(db.pool, vehicles, () => smtpOn)),
  ], notifier));
  await setModule(db.pool, 'service', true);
});
after(async () => { await notifier?.stop(); app?.close(); await db?.drop(); });
afterEach(async () => {
  if (!db) return;
  await notifier.settled();
  await db.pool.query('UPDATE vehicle_notification_settings SET email_enabled = false');
  await db.pool.query("UPDATE notification_outbox SET status = 'cancelled' WHERE status IN ('pending', 'sending')");
  await setModule(db.pool, 'service', true);
  mailer.sent.length = 0; mailer.fail = false; smtpOn = true; logs = [];
  mailerImpl = () => (smtpOn ? mailer : null);
});

const S = (v: string) => `/v1/vehicles/${v}/notification-settings`;
const ME = (v: string) => `/v1/vehicles/${v}/notification-preferences/me`;
async function vehicle(over: Record<string, unknown> = {}, { enable = true, recipients = [] as TestUser[], followUpDays = 7 } = {}): Promise<Id> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'EUR', ...over });
  assert.equal(v.status, 201, v.text);
  for (const [u, role] of [[editor, 'editor'], [driver, 'driver'], [viewer, 'viewer']] as const) await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: u.id, role });
  if (enable) {
    const r = await app.call(owner, 'PUT', S(v.json.id), { emailEnabled: true, followUpDays, recipientUserIds: recipients.map((u) => u.id) });
    assert.equal(r.status, 200, r.text);
  }
  return v.json.id;
}
const task = async (v: Id, body: Record<string, unknown>) => { const r = await app.call(owner, 'POST', `/v1/vehicles/${v}/maintenance-tasks`, body); assert.equal(r.status, 201, r.text); return r.json as { id: Id; name: string }; };
const outbox = async (v: Id) => (await db!.pool.query<{ id: Id; user_id: Id; status: string; attempts: number; payload: any; last_error: string | null; next_attempt_at: Date }>(
  'SELECT id, user_id, status, attempts, payload, last_error, next_attempt_at FROM notification_outbox WHERE vehicle_id = $1 ORDER BY created_at, id', [v])).rows;
const pending = async (v: Id) => (await outbox(v)).filter((r) => r.status === 'pending');
const to = (u: TestUser) => mailer.sent.filter((m) => m.to === u.email);

test('emails are off until the owner or a manager turns them on', { skip }, async () => {
  const v = await vehicle({}, { enable: false });
  await task(v, { name: 'Oil change', recurring: false, firstDueOn: day(5) });
  const r = await app.call(owner, 'GET', S(v));
  assert.equal(r.status, 200);
  assert.equal(r.json.emailEnabled, false); assert.equal(r.json.followUpDays, 7); assert.equal(r.json.leadDays, 30);
  assert.deepEqual(r.json.leadDistance, { value: '500', unit: 'km' });
  assert.deepEqual(r.json.me, { eligible: true, selected: true, optedOut: false, receiving: false });
  assert.equal((await notifier.runEvaluation(new Date())).enqueued, 0);
  assert.deepEqual(await outbox(v), []);
  // In-app status is unaffected.
  const t = await app.call(owner, 'GET', `/v1/vehicles/${v}/maintenance-tasks`);
  assert.equal(t.json.items[0].status, 'due_soon');
});

test('recipients: owner by default, selected driver, viewer never, opt-out wins, revoked member gets nothing', { skip }, async () => {
  const v = await vehicle({}, { recipients: [driver] });
  assert.deepEqual((await recipientsOf(db!.pool, v)).map((r) => r.userId), [owner.id, driver.id]);
  assert.equal((await app.call(owner, 'PUT', S(v), { recipientUserIds: [viewer.id] })).status, 422, 'a viewer cannot be selected');
  assert.equal((await app.call(owner, 'PUT', S(v), { recipientUserIds: [stranger.id] })).status, 422, 'a non-member cannot be selected');
  // The owner may be listed; it changes nothing.
  assert.equal((await app.call(owner, 'PUT', S(v), { recipientUserIds: [owner.id, driver.id, editor.id] })).status, 200);
  assert.deepEqual((await recipientsOf(db!.pool, v)).map((r) => r.userId).sort(), [owner.id, editor.id, driver.id].sort());
  // Opt-out wins over the selection, and selecting again does not override it.
  const me = await app.call(editor, 'PUT', ME(v), { emailMe: false });
  assert.equal(me.status, 200); assert.equal(me.json.me.optedOut, true); assert.equal(me.json.me.receiving, false);
  await app.call(owner, 'PUT', S(v), { recipientUserIds: [driver.id, editor.id] });
  assert.ok(!(await recipientsOf(db!.pool, v)).some((r) => r.userId === editor.id));
  // The owner can opt out too.
  await app.call(owner, 'PUT', ME(v), { emailMe: false });
  assert.deepEqual((await recipientsOf(db!.pool, v)).map((r) => r.userId), [driver.id]);
  await app.call(owner, 'PUT', ME(v), { emailMe: true });

  await task(v, { name: 'Brakes', recurring: false, firstDueOn: day(3) });
  await notifier.evaluateVehicle(v, new Date());
  assert.deepEqual((await pending(v)).map((r) => r.user_id).sort(), [owner.id, driver.id].sort());
  // Revoked after queueing: the driver's row is cancelled at dispatch.
  assert.equal((await app.call(owner, 'DELETE', `/v1/vehicles/${v}/members/${driver.id}`)).status, 204);
  const d = await notifier.dispatchOutbox(new Date());
  assert.equal(d.sent, 1); assert.equal(d.cancelled, 1);
  assert.equal(to(owner).length, 1); assert.equal(to(driver).length, 0);
  assert.equal((await outbox(v)).find((r) => r.user_id === driver.id)!.last_error, 'not_a_recipient');
  assert.equal((await db!.pool.query('SELECT count(*)::int AS n FROM vehicle_notification_recipients WHERE vehicle_id = $1 AND user_id = $2', [v, driver.id])).rows[0].n, 0, 'the selection went with the membership');
  await app.call(owner, 'POST', `/v1/vehicles/${v}/members`, { userId: driver.id, role: 'driver' });
});

test('one email per recipient per vehicle, grouping every task that needs a reminder', { skip }, async () => {
  const v = await vehicle({}, { recipients: [driver] });
  await task(v, { name: 'Oil change', recurring: false, firstDueOn: day(10) });
  await task(v, { name: 'Wipers', recurring: false, firstDueOn: day(-2) });
  await task(v, { name: 'Far away', recurring: false, firstDueOn: day(200) });
  const e = await notifier.evaluateVehicle(v, new Date());
  assert.equal(e.enqueued, 2);
  const rows = await pending(v);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(r.payload.tasks.map((t: any) => [t.name, t.status]).sort(), [['Oil change', 'due_soon'], ['Wipers', 'overdue']]);
  await notifier.dispatchOutbox(new Date());
  assert.equal(to(owner).length, 1); assert.equal(to(driver).length, 1);
  assert.match(to(owner)[0]!.text, /Oil change: due soon/); assert.match(to(owner)[0]!.text, /Wipers: overdue/);
  assert.ok(!to(owner)[0]!.text.includes('Far away'));
  assert.ok(to(owner)[0]!.html?.includes('<ul>'));
});

test('snoozed tasks are left out and come back after the snooze ends', { skip }, async () => {
  const v = await vehicle({}, { followUpDays: 0 });
  const a = await task(v, { name: 'Oil change', recurring: false, firstDueOn: day(10) });
  await task(v, { name: 'Wipers', recurring: false, firstDueOn: day(12) });
  // Announced once, then snoozed.
  await notifier.evaluateVehicle(v, new Date()); await notifier.dispatchOutbox(new Date());
  assert.equal(to(owner).length, 1);
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/maintenance-tasks/${a.id}/snooze`, { until: day(3) })).status, 200);
  mailer.sent.length = 0;
  for (const n of [0, 1, 2, 3]) { await notifier.evaluateVehicle(v, at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(to(owner).length, 0, 'nothing new while snoozed (and no follow-ups)');
  // The snooze ended on day 3: the task is announced again.
  await notifier.evaluateVehicle(v, at(4)); await notifier.dispatchOutbox(at(4));
  assert.equal(to(owner).length, 1);
  assert.match(to(owner)[0]!.text, /Oil change: due soon/);
  assert.ok(!to(owner)[0]!.text.includes('Wipers'), 'Wipers was already announced and there are no follow-ups');

  // A snooze set while a reminder is queued drops the task from it before sending.
  const v2 = await vehicle({}, { followUpDays: 0 });
  const b = await task(v2, { name: 'Battery', recurring: false, firstDueOn: day(4) });
  await notifier.evaluateVehicle(v2, new Date());
  assert.equal((await pending(v2)).length, 1);
  await app.call(owner, 'PUT', `/v1/vehicles/${v2}/maintenance-tasks/${b.id}/snooze?scope=vehicle`, { until: day(2) });
  mailer.sent.length = 0;
  assert.equal((await notifier.dispatchOutbox(new Date())).cancelled, 1);
  assert.equal(to(owner).length, 0);
});

test('due soon then overdue: each level is announced once', { skip }, async () => {
  const v = await vehicle({}, { followUpDays: 0 });
  await task(v, { name: 'Inspection', recurring: false, firstDueOn: day(5) });
  for (const n of [0, 1, 2]) { await notifier.evaluateVehicle(v, at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(to(owner).length, 1); assert.match(to(owner)[0]!.text, /Inspection: due soon/);
  for (const n of [6, 7, 20]) { await notifier.evaluateVehicle(v, at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(to(owner).length, 2); assert.match(to(owner)[1]!.text, /Inspection: overdue/);
  assert.match(to(owner)[1]!.subject, /overdue/);
});

test('follow-ups follow the cadence, and fill-ups or re-evaluation never send again', { skip }, async () => {
  const v = await vehicle({}, { followUpDays: 7 });
  await task(v, { name: 'Timing belt', recurring: false, firstDueOn: day(-3) });
  await notifier.evaluateVehicle(v, new Date()); await notifier.dispatchOutbox(new Date());
  assert.equal(to(owner).length, 1);
  // Fill-ups trigger an evaluation (fire and forget); nothing new is sent.
  for (const km of ['1000', '1100', '1200']) {
    const f = await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(0)}T0${km[1]}:00:00Z`, odometer: { value: km, unit: 'km' }, volume: { value: '10', unit: 'l' } });
    assert.equal(f.status, 201, f.text);
    await notifier.settled();
  }
  for (const n of [1, 3, 6]) { await notifier.runEvaluation(at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(to(owner).length, 1, 'no repeat before the follow-up is due');
  await notifier.evaluateVehicle(v, at(7.01)); await notifier.dispatchOutbox(at(7.01));
  assert.equal(to(owner).length, 2, 'follow-up after 7 days');
  await notifier.evaluateVehicle(v, at(10)); await notifier.dispatchOutbox(at(10));
  assert.equal(to(owner).length, 2);
  await notifier.evaluateVehicle(v, at(14.02)); await notifier.dispatchOutbox(at(14.02));
  assert.equal(to(owner).length, 3, 'second follow-up');
  // Cadence 0: no further follow-ups.
  await app.call(editor, 'PUT', S(v), { followUpDays: 0 });
  for (const n of [21.1, 40, 80]) { await notifier.evaluateVehicle(v, at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(to(owner).length, 3);
});

test('a fill-up with a new odometer that makes a task due sends once, after the request', { skip }, async () => {
  const v = await vehicle({}, { followUpDays: 0 });
  await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(-5)}T08:00:00Z`, odometer: { value: '10000', unit: 'km' }, volume: { value: '10', unit: 'l' } });
  await notifier.settled();
  await task(v, { name: 'Tyres', recurring: false, firstDueOdometer: { value: '11000', unit: 'km' } });
  await notifier.evaluateVehicle(v, new Date());
  assert.equal((await outbox(v)).length, 0, 'not due yet');
  const f = await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(-1)}T08:00:00Z`, odometer: { value: '10700', unit: 'km' }, volume: { value: '10', unit: 'l' } });
  assert.equal(f.status, 201);
  await notifier.settled();
  assert.equal(to(owner).length, 1);
  assert.match(to(owner)[0]!.text, /Tyres: due soon/);
  assert.match(to(owner)[0]!.text, /Latest known odometer: 10,700 km/);
  await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: `${day(0)}T08:00:00Z`, odometer: { value: '10800', unit: 'km' }, volume: { value: '10', unit: 'l' } });
  await notifier.settled();
  assert.equal(to(owner).length, 1, 'no new email on the next fill-up');
});

test('the odometer trigger never fails the request', { skip }, async () => {
  const boom = { afterOdometerChange() { throw new Error('boom'); } };
  const routes = withOdometerTrigger([{ method: 'POST', path: '/v1/vehicles/:vehicleId/fill-ups', handler: async () => ({ status: 201, body: { ok: true } }) }], boom);
  const r = await routes[0]!.handler({ params: { vehicleId: 'x' }, body: {} } as never);
  assert.equal(r.status, 201);
  const calls: string[] = [];
  const spy = { afterOdometerChange(id: Id) { calls.push(id); } };
  const visits = withOdometerTrigger([{ method: 'POST', path: '/v1/vehicles/:vehicleId/service-visits', handler: async () => ({ status: 201 }) }], spy);
  await visits[0]!.handler({ params: { vehicleId: 'a' }, body: { items: [] } } as never);
  await visits[0]!.handler({ params: { vehicleId: 'b' }, body: { odometer: { value: '1', unit: 'km' } } } as never);
  assert.deepEqual(calls, ['b'], 'only visits with an odometer');
  // A failing evaluation in the background is logged, not thrown.
  const broken = new Notifier({ db: { connect: async () => { throw new Error('db down postgres://u:secretpw@h/db'); } } as never, mailer: () => null, publicOrigin: null, log: (m) => logs.push(m) });
  broken.afterOdometerChange('v' as Id);
  await broken.settled();
  assert.equal(logs.length, 1); assert.ok(!logs[0]!.includes('secretpw'));
});

test('idempotent: repeated and concurrent evaluations queue one row', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'Coolant', recurring: false, firstDueOn: day(7) });
  const now = new Date();
  await notifier.runEvaluation(now);
  await notifier.runEvaluation(now);
  assert.equal((await outbox(v)).length, 1);
  const v2 = await vehicle();
  await task(v2, { name: 'Coolant', recurring: false, firstDueOn: day(7) });
  await Promise.all([notifier.runEvaluation(now), notifier.runEvaluation(now), notifier.evaluateVehicle(v2, now), notifier.evaluateVehicle(v2, now)]);
  assert.equal((await outbox(v2)).length, 1);
  // The tick lock: a second evaluator skips while another holds it.
  const holder = await db!.pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [0x444c4e54]);
    assert.equal((await notifier.runEvaluation(now)).skipped, 'locked');
  } finally { await holder.query('SELECT pg_advisory_unlock($1)', [0x444c4e54]); holder.release(); }
  // Two notifiers (two app instances) sending at once deliver each row once.
  const other = new Notifier({ db: db!.pool, mailer: () => mailer, publicOrigin: ORIGIN });
  await Promise.all([notifier.dispatchOutbox(now), other.dispatchOutbox(now)]);
  assert.equal(to(owner).length, 2, 'one per vehicle');
});

test('a claimed row whose lease expired is sent again (crash recovery); a live lease is left alone', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'Air filter', recurring: false, firstDueOn: day(7) });
  const now = new Date();
  await notifier.evaluateVehicle(v, now);
  const [row] = await outbox(v);
  await db!.pool.query("UPDATE notification_outbox SET status = 'sending', claimed_by = 'dead-instance', claimed_at = $2, lease_until = $3, attempts = 1 WHERE id = $1",
    [row!.id, now, new Date(now.getTime() + 60_000)]);
  assert.equal((await notifier.dispatchOutbox(now)).sent, 0, 'lease still held');
  const d = await notifier.dispatchOutbox(new Date(now.getTime() + 61_000));
  assert.equal(d.sent, 1);
  const [done] = await outbox(v);
  assert.equal(done!.status, 'sent'); assert.equal(done!.attempts, 2);
});

test('a sender whose claim was taken over does not overwrite the new owner\'s row', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'Cabin filter', recurring: false, firstDueOn: day(7) });
  const now = new Date();
  await notifier.evaluateVehicle(v, now);
  // While this instance is sending, another one takes the row over (as after a lease expiry).
  mailerImpl = () => ({ async send(addr, subject, text, html) {
    await db!.pool.query("UPDATE notification_outbox SET claimed_by = 'other-instance' WHERE vehicle_id = $1", [v]);
    await mailer.send(addr, subject, text, html);
  } });
  const d = await notifier.dispatchOutbox(now);
  assert.equal(d.sent, 1, 'the send happened');
  const [r] = await outbox(v);
  assert.equal(r!.status, 'sending', 'left to the instance that holds the claim now');
});

test('failed sends retry with backoff, then stop as failed, without storing credentials', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'Spark plugs', recurring: false, firstDueOn: day(7) });
  let t = Date.now();
  await notifier.evaluateVehicle(v, new Date(t));
  mailerImpl = () => ({ async send() { throw Object.assign(new Error('535 auth failed for smtp://mailer:hunter2@mail.example.test'), { responseCode: 535 }); } });
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const d = await notifier.dispatchOutbox(new Date(t));
    const [r] = await outbox(v);
    assert.equal(r!.attempts, i);
    assert.ok(r!.last_error && !r!.last_error.includes('hunter2'), r!.last_error ?? '');
    if (i < MAX_ATTEMPTS) {
      assert.equal(d.retried, 1); assert.equal(r!.status, 'pending');
      assert.equal(r!.next_attempt_at.getTime(), t + retryDelayMs(i));
      assert.equal((await notifier.dispatchOutbox(new Date(t + retryDelayMs(i) - 1))).retried, 0, 'not before the backoff');
      t += retryDelayMs(i);
    } else { assert.equal(d.failed, 1); assert.equal(r!.status, 'failed'); }
  }
  assert.equal((await notifier.dispatchOutbox(new Date(t + 10 * DAY))).retried + (await notifier.dispatchOutbox(new Date(t + 10 * DAY))).failed, 0, 'failed rows stay failed');
  assert.ok(logs.every((l) => !l.includes('hunter2')));
  const s = await app.call(owner, 'GET', S(v));
  assert.equal(s.json.delivery.failed, 1);
  assert.ok(!JSON.stringify(s.json).includes('535'), 'no error text in the API');
});

test('without SMTP nothing is claimed or attempted; rows wait and the in-app status works', { skip }, async () => {
  smtpOn = false;
  const v = await vehicle();
  await task(v, { name: 'Brake fluid', recurring: false, firstDueOn: day(7) });
  await notifier.evaluateVehicle(v, new Date());
  assert.deepEqual(await notifier.dispatchOutbox(new Date()), { skipped: 'no_smtp', sent: 0, retried: 0, failed: 0, cancelled: 0 });
  const [r] = await outbox(v);
  assert.equal(r!.status, 'pending'); assert.equal(r!.attempts, 0);
  assert.deepEqual(logs, [], 'no error spam');
  const s = await app.call(owner, 'GET', S(v));
  assert.equal(s.json.smtpConfigured, false); assert.equal(s.json.delivery.pending, 1); assert.equal(s.json.me.receiving, true);
  assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${v}/maintenance-status`)).json.counts.needsAttention, 1);
  // Re-evaluating while SMTP is missing does not pile up rows.
  await notifier.evaluateVehicle(v, at(1)); await notifier.evaluateVehicle(v, at(2));
  assert.equal((await pending(v)).length, 1);
  // Once configured, the waiting row is sent.
  smtpOn = true;
  assert.equal((await notifier.dispatchOutbox(at(2))).sent, 1);
});

test('turning the module off stops service emails and cancels queued ones', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'Battery', recurring: false, firstDueOn: day(7) });
  await notifier.evaluateVehicle(v, new Date());
  assert.equal((await pending(v)).length, 1);
  await setModule(db!.pool, 'service', false);
  const r = await notifier.runEvaluation(new Date());
  assert.equal(r.skipped, 'module_disabled');
  assert.equal((await outbox(v))[0]!.status, 'cancelled');
  assert.equal((await notifier.dispatchOutbox(new Date())).sent, 0);
  assert.equal((await app.call(owner, 'GET', S(v))).json.code, 'module_disabled');
  // Queued but claimed while the module goes off: cancelled at dispatch.
  await setModule(db!.pool, 'service', true);
  await notifier.evaluateVehicle(v, at(30));
  await setModule(db!.pool, 'service', false);
  assert.equal((await notifier.dispatchOutbox(at(30))).cancelled, 1);
  assert.equal(mailer.sent.length, 0);
});

test('turning a vehicle\'s emails off or archiving it cancels what was queued', { skip }, async () => {
  const v = await vehicle();
  await task(v, { name: 'Wipers', recurring: false, firstDueOn: day(7) });
  await notifier.evaluateVehicle(v, new Date());
  await app.call(owner, 'PUT', S(v), { emailEnabled: false });
  await notifier.runEvaluation(new Date());
  assert.equal((await outbox(v))[0]!.status, 'cancelled');
  await app.call(owner, 'PUT', S(v), { emailEnabled: true });
  await notifier.evaluateVehicle(v, new Date());
  assert.equal((await pending(v)).length, 0, 'already told: re-enabling does not resend');
});

test('completing a task through a linked visit cancels reminders that only covered it', { skip }, async () => {
  const v = await vehicle({}, { followUpDays: 0 });
  const a = await task(v, { name: 'Oil change', recurring: true, intervalDays: 365, firstDueOn: day(3) });
  await notifier.evaluateVehicle(v, new Date());
  assert.equal((await pending(v)).length, 1);
  const visit = await app.call(driver, 'POST', `/v1/vehicles/${v}/service-visits`, { servicedOn: day(0), odometer: { value: '5000', unit: 'km' }, items: [{ name: 'Oil change', taskId: a.id }] });
  assert.equal(visit.status, 201, visit.text);
  await notifier.settled(); // the visit had an odometer, so it triggered an evaluation
  assert.equal((await outbox(v))[0]!.status, 'cancelled');
  assert.equal((await outbox(v))[0]!.last_error, 'no_longer_due');
  assert.equal(mailer.sent.length, 0);

  // With two tasks queued, completing one sends only the other.
  const b = await task(v, { name: 'Wipers', recurring: false, firstDueOn: day(4) });
  await task(v, { name: 'Coolant', recurring: false, firstDueOn: day(5) });
  smtpOn = false;
  await notifier.evaluateVehicle(v, new Date());
  await app.call(owner, 'POST', `/v1/vehicles/${v}/service-visits`, { servicedOn: day(0), items: [{ name: 'Wipers', taskId: b.id }] });
  smtpOn = true;
  await notifier.dispatchOutbox(new Date());
  assert.equal(to(owner).length, 1);
  assert.match(to(owner)[0]!.text, /Coolant/); assert.ok(!to(owner)[0]!.text.includes('Wipers'));
});

test('the email carries no plate, VIN, notes, costs or receipts', { skip }, async () => {
  const v = await vehicle({ name: null, make: 'Volvo', model: 'V70 <x>', year: 2004, plateRegion: 'CH', plateNumber: 'PLATE 123', vin: 'YV1SW61R021234567' });
  await task(v, { name: 'Oil & <filter>', recurring: false, firstDueOn: day(5), notes: 'TASKNOTE-SECRET' });
  await app.call(owner, 'POST', `/v1/vehicles/${v}/service-visits`, { servicedOn: day(-1), odometer: { value: '1234', unit: 'km' }, provider: 'PROVIDER-SECRET', totalCost: '99.95', notes: 'VISITNOTE-SECRET', items: [{ name: 'Check', cost: '12.34' }] });
  await notifier.settled();
  await notifier.evaluateVehicle(v, new Date()); await notifier.dispatchOutbox(new Date());
  const m = to(owner)[0]!;
  assert.ok(m, 'sent');
  const all = `${m.subject}\n${m.text}\n${m.html}`;
  for (const secret of ['PLATE', '123 ', 'YV1SW61R021234567', 'TASKNOTE', 'VISITNOTE', 'PROVIDER', '99.95', '12.34', 'CH ']) assert.ok(!all.includes(secret), `leaked ${secret}`);
  assert.match(m.subject, /2004 Volvo V70 <x>/);
  assert.ok(m.html!.includes('2004 Volvo V70 &lt;x&gt;')); assert.ok(m.html!.includes('Oil &amp; &lt;filter&gt;'));
  assert.ok(m.text.includes(`${ORIGIN}/#/vehicles/${v}/service?view=maintenance`));
  assert.match(m.text, /Latest known odometer: 1,234 km/);
  const payload = JSON.stringify((await outbox(v))[0]!.payload);
  for (const secret of ['PLATE', 'TASKNOTE', 'VISITNOTE', 'PROVIDER', 'YV1SW']) assert.ok(!payload.includes(secret), `payload holds ${secret}`);
});

test('API: permissions, 404 for non-members and with the module off, 409 when archived, audit', { skip }, async () => {
  const v = await vehicle({}, { enable: false });
  // Reads: any member; only managers see recipients and delivery.
  for (const u of [owner, editor]) {
    const r = await app.call(u, 'GET', S(v));
    assert.equal(r.status, 200); assert.equal(r.json.canManage, true);
    assert.deepEqual(r.json.recipients.map((x: any) => x.role), ['owner', 'editor', 'driver'], 'viewers are not listed as recipients');
    assert.deepEqual(r.json.delivery, { lastSentAt: null, pending: 0, failed: 0 });
  }
  for (const u of [driver, viewer]) {
    const r = await app.call(u, 'GET', S(v));
    assert.equal(r.status, 200); assert.equal(r.json.canManage, false); assert.equal(r.json.recipients, null); assert.equal(r.json.delivery, null);
    assert.equal(typeof r.json.smtpConfigured, 'boolean');
  }
  assert.deepEqual((await app.call(viewer, 'GET', S(v))).json.me, { eligible: false, selected: false, optedOut: false, receiving: false });
  assert.equal((await app.call(stranger, 'GET', S(v))).status, 404);
  assert.equal((await app.call(stranger, 'PUT', S(v), { emailEnabled: true })).status, 404);
  assert.equal((await app.call(stranger, 'PUT', ME(v), { emailMe: false })).status, 404);
  assert.equal((await app.call(null, 'GET', S(v))).status, 401);
  // Writes.
  assert.equal((await app.call(driver, 'PUT', S(v), { emailEnabled: true })).status, 403);
  assert.equal((await app.call(viewer, 'PUT', S(v), { followUpDays: 3 })).status, 403);
  const ed = await app.call(editor, 'PUT', S(v), { emailEnabled: true, followUpDays: 14, recipientUserIds: [driver.id] });
  assert.equal(ed.status, 200, ed.text); assert.equal(ed.json.emailEnabled, true); assert.equal(ed.json.followUpDays, 14);
  assert.equal(ed.json.recipients.find((x: any) => x.userId === driver.id).selected, true);
  assert.deepEqual((await app.call(driver, 'GET', S(v))).json.me, { eligible: true, selected: true, optedOut: false, receiving: true });
  for (const bad of [{}, { followUpDays: 91 }, { followUpDays: -1 }, { followUpDays: 1.5 }, { emailEnabled: 'yes' }, { recipientUserIds: ['nope'] }, { other: 1 }]) {
    assert.equal((await app.call(owner, 'PUT', S(v), bad)).status, 422, JSON.stringify(bad));
  }
  assert.equal((await app.call(viewer, 'PUT', ME(v), { emailMe: false })).status, 200, 'anyone may opt out');
  assert.equal((await app.call(viewer, 'PUT', ME(v), {})).status, 422);
  const audits = (await db!.pool.query<{ action: string; details: any }>("SELECT action, details FROM audit_events WHERE subject_id = $1 AND action LIKE 'notification_%' ORDER BY occurred_at", [v])).rows;
  assert.deepEqual(audits.map((a) => a.action), ['notification_settings.update', 'notification_preference.update']);
  assert.deepEqual(audits[0]!.details, { emailEnabled: true, followUpDays: 14, recipients: 1 });
  assert.ok(!JSON.stringify(audits).includes('@'), 'no addresses in the audit');
  // Archived: writes are 409, reads still work.
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true })).status, 200);
  assert.equal((await app.call(owner, 'PUT', S(v), { emailEnabled: false })).status, 409);
  assert.equal((await app.call(driver, 'PUT', ME(v), { emailMe: false })).status, 409);
  assert.equal((await app.call(owner, 'GET', S(v))).status, 200);
  // Module off: 404 module_disabled for every route.
  await setModule(db!.pool, 'service', false);
  for (const [m, p, b] of [['GET', S(v), undefined], ['PUT', S(v), { emailEnabled: true }], ['PUT', ME(v), { emailMe: true }]] as const) {
    const r = await app.call(owner, m, p, b);
    assert.equal(r.status, 404); assert.equal(r.json.code, 'module_disabled');
  }
});

// ---------- per-task reminders switch (presets, Phase A) ----------
test('acceptance 7: a task with reminders off is never emailed; other tasks are unaffected', { skip }, async () => {
  const v = await vehicle({}, { recipients: [driver], followUpDays: 0 });
  await task(v, { name: 'Wipers', intervalMonths: 1, baselineKind: 'reported', baselineOn: day(-60) });
  await task(v, { name: 'Brake fluid', intervalMonths: 36, baselineKind: 'reported', baselineOn: day(-1200), remindersEnabled: false });
  await notifier.evaluateVehicle(v, new Date()); await notifier.dispatchOutbox(new Date());
  assert.equal(to(owner).length, 1); assert.equal(to(driver).length, 1);
  assert.match(to(owner)[0]!.text, /Wipers: overdue/);
  assert.ok(!to(owner)[0]!.text.includes('Brake fluid'), 'reminders are off for this task');
  // Imported-style tasks with every reminder off: nothing at all is queued.
  const v2 = await vehicle({}, { followUpDays: 0 });
  await task(v2, { name: 'Timing belt', intervalMonths: 1, baselineKind: 'tracking', baselineOn: day(-90), remindersEnabled: false });
  assert.equal((await notifier.evaluateVehicle(v2, new Date())).enqueued, 0);
  assert.deepEqual(await outbox(v2), []);
});

test('acceptance 7: turning reminders on later sends no backlog or catch-up, only what changes from then on', { skip }, async () => {
  const v = await vehicle({}, { recipients: [driver], followUpDays: 0 });
  const other = await task(v, { name: 'Wipers', intervalMonths: 1, baselineKind: 'reported', baselineOn: day(-60) });
  const brake = await task(v, { name: 'Brake fluid', intervalMonths: 36, baselineKind: 'reported', baselineOn: day(-1200), remindersEnabled: false });
  const soon = await task(v, { name: 'Coolant', recurring: true, intervalDays: 100, baselineKind: 'reported', baselineOn: day(-90), remindersEnabled: false });
  for (const n of [0, 1, 2]) { await notifier.evaluateVehicle(v, at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(to(owner).length, 1, 'only the task with reminders on'); mailer.sent.length = 0;
  // A queued reminder for a task is cancelled if its reminders are turned off before sending.
  const r1 = await app.call(owner, 'PATCH', `/v1/vehicles/${v}/maintenance-tasks/${other.id}`, { intervalMonths: 2, baselineOn: day(-70) });
  assert.equal(r1.status, 200, r1.text);
  await notifier.evaluateVehicle(v, at(2));
  assert.equal((await pending(v)).length, 2, 'a new due point for Wipers is queued for both recipients');
  await app.call(owner, 'PATCH', `/v1/vehicles/${v}/maintenance-tasks/${other.id}`, { remindersEnabled: false });
  assert.equal((await notifier.dispatchOutbox(at(2))).cancelled, 2); assert.equal(mailer.sent.length, 0);

  // Opt in on the overdue and due-soon tasks: their current state counts as announced, for every possible recipient.
  for (const t of [brake, soon]) {
    const r = await app.call(owner, 'PATCH', `/v1/vehicles/${v}/maintenance-tasks/${t.id}`, { remindersEnabled: true });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.remindersEnabled, true);
  }
  const ledger = (await db!.pool.query('SELECT user_id, task_id, level FROM notification_task_log WHERE vehicle_id = $1 AND task_id = ANY($2::uuid[])', [v, [brake.id, soon.id]])).rows;
  assert.equal(ledger.filter((l) => l.task_id === brake.id && l.level === 'overdue').length, 3, 'owner, editor and driver; never the viewer');
  assert.ok(!ledger.some((l) => l.user_id === viewer.id));
  for (const n of [2, 3, 4]) { await notifier.evaluateVehicle(v, at(n)); await notifier.dispatchOutbox(at(n)); }
  assert.equal(mailer.sent.length, 0, 'no catch-up storm after opting in');
  // What changes afterwards is announced as usual: Coolant moves from due soon to overdue.
  await notifier.evaluateVehicle(v, at(12)); await notifier.dispatchOutbox(at(12));
  assert.equal(to(owner).length, 1); assert.match(to(owner)[0]!.text, /Coolant: overdue/);
  assert.ok(!to(owner)[0]!.text.includes('Brake fluid'), 'still the same overdue point, already counted as announced');
  // Turning reminders on for one task does not change the others' switches.
  const all = (await app.call(owner, 'GET', `/v1/vehicles/${v}/maintenance-tasks`)).json.items;
  assert.deepEqual(all.map((t: any) => [t.name, t.remindersEnabled]), [['Wipers', false], ['Brake fluid', true], ['Coolant', true]]);
});
