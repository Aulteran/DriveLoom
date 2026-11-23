// Maintenance planning rules, pure and database-free so they can be tested
// exhaustively and reused by notifications. Nothing here knows a manufacturer
// schedule: every interval comes from a person.
//
// Semantics
//  - A task is time-based (intervalDays), distance-based (intervalDistance), or both;
//    with both, whichever is reached first makes it due.
//  - Baseline: the most recent service item linked to the task (visit date and,
//    when recorded, visit odometer) plus the interval. With no linked
//    completion, the task's own first-due date/odometer. With neither the
//    status is `no_baseline`: history is never invented, and "ok" is never implied.
//  - Dates are calendar dates compared in UTC. Due today is `due_soon`; overdue means past.
//  - Distance: odometer above the due odometer is `overdue`; within the lead
//    distance (and not above) is `due_soon`. Only the latest known reading is used and never extrapolated.
//    A missing reading, or one older than STALE_READING_DAYS, cannot show a
//    distance as "ok": it yields `unknown_reading` (a stale reading can still
//    prove due/overdue, because odometers only go up).
//  - Overall: overdue > due_soon > unknown_reading > ok. A time-only task never needs a reading.
//  - One-time tasks with a linked completion are `completed`.
//  - Snoozes only mute reminders: they never change dueOn, dueOdometer or status.
import { Dec } from '../decimal.ts';
import type { DistanceUnit } from '../types.ts';
import { KM_PER } from '../units.ts';

/** Illustrative defaults, shown to people as such. Not manufacturer or safety guidance. */
export const LEAD_DAYS = 30;
export const LEAD_DISTANCE = 500; // in the person's distance unit (km or mi)
export const STALE_READING_DAYS = 90;
export const leadDistanceKm = (unit: DistanceUnit): Dec => Dec.int(LEAD_DISTANCE).mul(KM_PER[unit]);

/** Common service types, names only: no intervals, no numbers. */
export const CATALOG = [
  { key: 'oil_change', name: 'Oil change' },
  { key: 'tyre_rotation', name: 'Tyre rotation' },
  { key: 'brake_inspection', name: 'Brake inspection' },
  { key: 'air_filter', name: 'Air filter' },
  { key: 'cabin_filter', name: 'Cabin filter' },
  { key: 'coolant', name: 'Coolant' },
  { key: 'brake_fluid', name: 'Brake fluid' },
  { key: 'battery', name: 'Battery' },
  { key: 'spark_plugs', name: 'Spark plugs' },
  { key: 'timing_belt', name: 'Timing belt' },
  { key: 'wipers', name: 'Wipers' },
  { key: 'general_inspection', name: 'General inspection' },
] as const;
export const catalogName = (key: string): string | undefined => CATALOG.find((c) => c.key === key)?.name;

export const TASK_STATES = ['ok', 'due_soon', 'overdue', 'no_baseline', 'unknown_reading', 'completed'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface TaskSchedule {
  recurring: boolean;
  intervalDays: number | null;
  intervalDistanceKm: Dec | null;
  firstDueOn: string | null;
  firstDueOdometerKm: Dec | null;
}
export interface Completion { servicedOn: string; odometerKm: Dec | null }
export interface Reading { km: Dec; on: string }

export interface TaskStatus {
  state: TaskState;
  dueOn: string | null;
  dueOdometerKm: Dec | null;
  /** Calendar days from today to dueOn (negative when past); null without a due date. */
  daysUntilDue: number | null;
  /** Kilometres from the latest reading to dueOdometer (negative when past); null without both. */
  distanceUntilDueKm: Dec | null;
  baseline: 'completion' | 'first_due' | 'none';
  /** A distance interval exists but the last completion recorded no odometer, so no next odometer can be worked out. */
  distanceBaselineMissing: boolean;
  /** The task has a distance due point and the reading is missing or older than STALE_READING_DAYS. */
  readingStale: boolean;
}

const DAY = 86_400_000;
const ts = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
export const daysBetween = (from: string, to: string): number => Math.round((ts(to) - ts(from)) / DAY);
export const addDays = (d: string, n: number): string => new Date(ts(d) + n * DAY).toISOString().slice(0, 10);
export const utcDate = (now: Date): string => now.toISOString().slice(0, 10);

const RANK: Record<TaskState, number> = { ok: 0, unknown_reading: 1, due_soon: 2, overdue: 3, no_baseline: -1, completed: -1 };
const worst = (a: TaskState, b: TaskState): TaskState => (RANK[a] >= RANK[b] ? a : b);

export function computeStatus(
  t: TaskSchedule, last: Completion | null, reading: Reading | null, today: string, distanceUnit: DistanceUnit,
): TaskStatus {
  let dueOn: string | null = null, dueOdometerKm: Dec | null = null;
  let baseline: TaskStatus['baseline'] = 'none', distanceBaselineMissing = false;
  if (!t.recurring && last) {
    return { state: 'completed', dueOn: null, dueOdometerKm: null, daysUntilDue: null, distanceUntilDueKm: null, baseline: 'completion', distanceBaselineMissing: false, readingStale: false };
  }
  if (last) {
    baseline = 'completion';
    if (t.intervalDays !== null) dueOn = addDays(last.servicedOn, t.intervalDays);
    if (t.intervalDistanceKm !== null) {
      if (last.odometerKm !== null) dueOdometerKm = last.odometerKm.add(t.intervalDistanceKm);
      else distanceBaselineMissing = true;
    }
  } else if (t.firstDueOn !== null || t.firstDueOdometerKm !== null) {
    baseline = 'first_due'; dueOn = t.firstDueOn; dueOdometerKm = t.firstDueOdometerKm;
  }
  if (dueOn === null && dueOdometerKm === null) {
    return { state: 'no_baseline', dueOn, dueOdometerKm, daysUntilDue: null, distanceUntilDueKm: null, baseline: last ? 'completion' : 'none', distanceBaselineMissing, readingStale: false };
  }
  const daysUntilDue = dueOn === null ? null : daysBetween(today, dueOn);
  const stale = reading === null || daysBetween(reading.on, today) > STALE_READING_DAYS;
  const distanceUntilDueKm = dueOdometerKm !== null && reading !== null ? dueOdometerKm.sub(reading.km) : null;

  let state: TaskState = 'ok';
  if (daysUntilDue !== null) state = daysUntilDue < 0 ? 'overdue' : daysUntilDue <= LEAD_DAYS ? 'due_soon' : 'ok';
  if (dueOdometerKm !== null) {
    let dim: TaskState;
    if (distanceUntilDueKm === null) dim = 'unknown_reading';
    else if (distanceUntilDueKm.isNegative()) dim = 'overdue';
    else if (distanceUntilDueKm.cmp(leadDistanceKm(distanceUnit)) <= 0) dim = 'due_soon';
    else dim = stale ? 'unknown_reading' : 'ok';
    state = worst(state, dim);
  }
  return { state, dueOn, dueOdometerKm, daysUntilDue, distanceUntilDueKm, baseline, distanceBaselineMissing, readingStale: dueOdometerKm !== null && stale };
}

export interface SnoozeRow { scope: 'personal' | 'vehicle'; untilDate: string | null; untilOdometerKm: Dec | null }

/**
 * A snooze is active until its date has passed (the date itself still counts)
 * or the known odometer exceeds its target, whichever comes first. An odometer
 * target with no known reading stays active: nothing shows it was passed.
 */
export function snoozeActive(s: SnoozeRow, today: string, reading: Reading | null): boolean {
  if (s.untilDate !== null && today > s.untilDate) return false;
  if (s.untilOdometerKm !== null && reading !== null && reading.km.cmp(s.untilOdometerKm) > 0) return false;
  return true;
}

/** Active snoozes visible to one person: their personal one first, then the vehicle-wide one. */
export function effectiveSnoozes<T extends SnoozeRow>(rows: T[], today: string, reading: Reading | null): T[] {
  return rows.filter((s) => snoozeActive(s, today, reading)).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'personal' ? -1 : 1));
}

/** States that deserve a reminder. `unknown_reading` and `no_baseline` are shown, never claimed as due. */
export const needsAttention = (s: TaskState): boolean => s === 'overdue' || s === 'due_soon';
