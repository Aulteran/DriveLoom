// Pure maintenance rules: status per dimension, baselines, stale readings, units,
// snooze expiry, and the shared odometer helper's contract (see maintenance.test.ts for the database side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '../src/decimal.ts';
import { addDays, computeStatus, effectiveSnoozes, needsAttention, snoozeActive, LEAD_DAYS, type TaskSchedule } from '../src/service/maintenance-status.ts';

const TODAY = '2026-06-15';
const km = (n: number | string) => Dec.parse(String(n));
const sched = (o: Partial<TaskSchedule> = {}): TaskSchedule => ({ recurring: true, intervalDays: null, intervalDistanceKm: null, firstDueOn: null, firstDueOdometerKm: null, ...o });
const reading = (n: number, on = TODAY) => ({ km: km(n), on });
const st = (t: TaskSchedule, last: { servicedOn: string; odometerKm: Dec | null } | null, r: ReturnType<typeof reading> | null, unit: 'km' | 'mi' = 'km') => computeStatus(t, last, r, TODAY, unit);

test('time-only: ok, due soon (inclusive of today and the lead edge), overdue, never needs a reading', () => {
  const t = sched({ intervalDays: 365 });
  const done = (on: string) => ({ servicedOn: on, odometerKm: null });
  assert.equal(st(t, done('2026-01-01'), null).state, 'ok');
  assert.equal(st(t, done('2026-01-01'), null).dueOn, '2027-01-01');
  assert.equal(st(t, done('2026-01-01'), null).readingStale, false, 'a time-only task never reports a stale reading');
  assert.equal(st(t, done(addDays(TODAY, LEAD_DAYS - 365)), null).state, 'due_soon', 'exactly 30 days ahead');
  assert.equal(st(t, done(addDays(TODAY, LEAD_DAYS + 1 - 365)), null).state, 'ok', '31 days ahead');
  assert.equal(st(t, done(addDays(TODAY, -365)), null).state, 'due_soon', 'due today');
  assert.equal(st(t, done(addDays(TODAY, -366)), null).state, 'overdue', 'yesterday');
  assert.equal(st(t, done(addDays(TODAY, -366)), null).daysUntilDue, -1);
});

test('no baseline is never up to date: nothing to count from, or a distance interval without a recorded odometer', () => {
  assert.equal(st(sched({ intervalDays: 365 }), null, null).state, 'no_baseline');
  assert.equal(st(sched({ intervalDays: 365 }), null, null).baseline, 'none');
  const dist = sched({ intervalDistanceKm: km(10000) });
  const s = st(dist, { servicedOn: '2026-05-01', odometerKm: null }, reading(50000));
  assert.equal(s.state, 'no_baseline'); assert.equal(s.distanceBaselineMissing, true); assert.equal(s.baseline, 'completion');
  // With a time interval too, the time dimension still works and the gap is flagged.
  const both = st(sched({ intervalDays: 30, intervalDistanceKm: km(10000) }), { servicedOn: '2026-05-01', odometerKm: null }, reading(50000));
  assert.equal(both.state, 'overdue'); assert.equal(both.dueOdometerKm, null); assert.equal(both.distanceBaselineMissing, true);
});

test('first due point is used only until the first completion, and completion replaces it entirely', () => {
  const t = sched({ intervalDays: 365, firstDueOn: '2026-06-20', firstDueOdometerKm: km(60000) });
  const first = st(t, null, reading(1000));
  assert.equal(first.baseline, 'first_due'); assert.equal(first.dueOn, '2026-06-20'); assert.equal(first.state, 'due_soon');
  const after = st(t, { servicedOn: '2026-06-01', odometerKm: null }, null);
  assert.equal(after.baseline, 'completion'); assert.equal(after.dueOn, '2027-06-01'); assert.equal(after.dueOdometerKm, null, 'first-due odometer is not mixed in');
  assert.equal(st(t, null, null).state, 'due_soon', 'worst known dimension wins while the distance reading is unknown');
});

test('distance: ok, due soon within 500 km, overdue above the due odometer, equal is not overdue', () => {
  const t = sched({ intervalDistanceKm: km(10000) });
  const last = { servicedOn: '2026-06-01', odometerKm: km(40000) }; // due at 50000
  assert.equal(st(t, last, reading(45000)).state, 'ok');
  assert.equal(st(t, last, reading(49500)).state, 'due_soon');
  assert.equal(st(t, last, reading(49499)).state, 'ok');
  assert.equal(st(t, last, reading(50000)).state, 'due_soon');
  assert.equal(st(t, last, reading(50001)).state, 'overdue');
  assert.equal(st(t, last, reading(50001)).distanceUntilDueKm?.toFixed(0), '-1');
  assert.equal(st(t, last, reading(45000)).dueOdometerKm?.toFixed(0), '50000');
});

test('lead distance follows the unit: 500 mi when the person uses miles', () => {
  const t = sched({ intervalDistanceKm: km(20000) });
  const last = { servicedOn: '2026-06-01', odometerKm: km(0) };
  assert.equal(st(t, last, reading(19300), 'km').state, 'ok', '700 km left, lead is 500 km');
  assert.equal(st(t, last, reading(19300), 'mi').state, 'due_soon', '700 km is about 435 mi, inside 500 mi');
  assert.equal(st(t, last, reading(19000), 'mi').state, 'ok', '1000 km is about 621 mi');
});

test('both dimensions: whichever is reached first, and overdue by either is overdue', () => {
  const t = sched({ intervalDays: 365, intervalDistanceKm: km(10000) });
  const last = { servicedOn: '2026-05-01', odometerKm: km(40000) }; // due 2027-05-01 or 50000
  assert.equal(st(t, last, reading(41000)).state, 'ok');
  assert.equal(st(t, last, reading(50500)).state, 'overdue', 'distance first');
  const old = { servicedOn: '2025-01-01', odometerKm: km(40000) };
  assert.equal(st(t, old, reading(41000)).state, 'overdue', 'date first, even with plenty of distance left');
  assert.equal(st(t, { servicedOn: '2025-07-01', odometerKm: km(40000) }, reading(41000)).state, 'due_soon', 'date due soon, distance ok');
});

test('stale or missing readings: never claim ok, never extrapolate, but can still prove due or overdue', () => {
  const t = sched({ intervalDistanceKm: km(10000) });
  const last = { servicedOn: '2026-01-01', odometerKm: km(40000) }; // due 50000
  const missing = st(t, last, null);
  assert.equal(missing.state, 'unknown_reading'); assert.equal(missing.readingStale, true); assert.equal(missing.distanceUntilDueKm, null);
  const stale = st(t, last, reading(41000, addDays(TODAY, -91)));
  assert.equal(stale.state, 'unknown_reading'); assert.equal(stale.readingStale, true);
  assert.equal(stale.distanceUntilDueKm?.toFixed(0), '9000', 'measured from the old reading, not projected forward');
  assert.equal(st(t, last, reading(41000, addDays(TODAY, -90))).state, 'ok', '90 days old is still current');
  assert.equal(st(t, last, reading(41000, addDays(TODAY, -90))).readingStale, false);
  assert.equal(st(t, last, reading(50100, addDays(TODAY, -200))).state, 'overdue', 'an old reading past the due point still proves overdue');
  assert.equal(st(t, last, reading(49800, addDays(TODAY, -200))).state, 'due_soon');
  // A known date that is ok does not hide an unknown distance.
  const both = st(sched({ intervalDays: 365, intervalDistanceKm: km(10000) }), { servicedOn: '2026-05-01', odometerKm: km(40000) }, null);
  assert.equal(both.state, 'unknown_reading');
});

test('one-time tasks: due once, then completed; a linked completion is final', () => {
  const t = sched({ recurring: false, firstDueOn: '2026-06-01' });
  assert.equal(st(t, null, null).state, 'overdue');
  const done = st(t, { servicedOn: '2026-06-10', odometerKm: null }, null);
  assert.equal(done.state, 'completed'); assert.equal(done.dueOn, null);
  assert.equal(needsAttention(done.state), false);
  assert.equal(st(sched({ recurring: false, firstDueOdometerKm: km(60000) }), null, reading(1000)).state, 'ok');
});

test('completion recompute: removing the latest linked completion falls back to the previous one, then to the first due point', () => {
  const t = sched({ intervalDays: 100, firstDueOn: '2026-03-01' });
  const older = { servicedOn: '2026-03-10', odometerKm: null }, newer = { servicedOn: '2026-06-01', odometerKm: null };
  assert.equal(st(t, newer, null).dueOn, '2026-09-09');
  assert.equal(st(t, older, null).dueOn, '2026-06-18', 'after the newer visit is deleted');
  const none = st(t, null, null);
  assert.equal(none.dueOn, '2026-03-01'); assert.equal(none.state, 'overdue', 'back to the first due date');
});

test('snoozes end by date or by odometer, whichever comes first, and never alter the status', () => {
  const byDate = { scope: 'personal' as const, untilDate: '2026-06-15', untilOdometerKm: null };
  assert.equal(snoozeActive(byDate, TODAY, null), true, 'the last day still counts');
  assert.equal(snoozeActive(byDate, '2026-06-16', null), false);
  const byKm = { scope: 'vehicle' as const, untilDate: null, untilOdometerKm: km(50000) };
  assert.equal(snoozeActive(byKm, TODAY, null), true, 'no reading: nothing shows the target was passed');
  assert.equal(snoozeActive(byKm, TODAY, reading(50000)), true, 'equal is not past');
  assert.equal(snoozeActive(byKm, TODAY, reading(50001)), false);
  const both = { scope: 'vehicle' as const, untilDate: '2026-07-01', untilOdometerKm: km(50000) };
  assert.equal(snoozeActive(both, TODAY, reading(49000)), true);
  assert.equal(snoozeActive(both, TODAY, reading(51000)), false, 'distance first');
  assert.equal(snoozeActive(both, '2026-07-02', reading(49000)), false, 'date first');
  // Personal sorts before vehicle-wide; expired ones drop out.
  const rows = [byKm, byDate, { scope: 'personal' as const, untilDate: '2026-01-01', untilOdometerKm: null }];
  assert.deepEqual(effectiveSnoozes(rows, TODAY, reading(49000)).map((r) => r.scope), ['personal', 'vehicle']);
  // The status itself is computed without any snooze input.
  const t = sched({ intervalDays: 30 });
  assert.equal(st(t, { servicedOn: '2026-01-01', odometerKm: null }, null).state, 'overdue');
});
