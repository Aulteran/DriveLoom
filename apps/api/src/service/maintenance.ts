// Maintenance planning: per-vehicle tasks (from a name-only catalog or typed in),
// status against the latest known odometer, and snoozes. Rules live in
// maintenance-status.ts (pure); this file is storage, permissions and views.
// Every method first requires the instance module (404 module_disabled), then
// normal vehicle access (404 for non-members). Owner and editor manage tasks and
// vehicle-wide snoozes (canManageSchedules); every member, viewers included,
// may snooze for themselves only, which is personal reminder state.
// Snoozes never change a task's due point or status. Personal snoozes are never
// exported; vehicle-wide ones are. No email or push here: see tasksNeedingAttention
// for the helper a notifier reuses (it leaves out tasks whose reminders are off).
// Preset provenance (presetId/presetVersion/presetTaskId, sourceTrust/sourceNote)
// is a label only: it never changes how status is computed.
import { auditAs } from '../audit.ts';
import { requireKeyGrant } from '../auth/api-key-auth.ts';
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import { HttpProblem } from '../http/problem.ts';
import { bool, invalid, obj } from '../http/validate.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Principal } from '../identity.ts';
import { quantity } from '../fuel/service.ts';
import { requireModule } from '../modules.ts';
import { getPreferences } from '../preferences.ts';
import type { Decimal, DistanceUnit, Id } from '../types.ts';
import { fromKm, isDistanceUnit, toKm } from '../units.ts';
import { EMAIL_RECIPIENT_ROLES, canManageSchedules } from '../vehicles/permissions.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { VehicleAccess } from '../vehicles/types.ts';
import { withIdempotency, type Idem } from '../auth/idempotency.ts';
import { dateOnly, text } from './fields.ts';
import {
  CATALOG, LEAD_DAYS, LEAD_DISTANCE, STALE_READING_DAYS, catalogName, computeStatus, daysBetween, effectiveSnoozes, needsAttention, occurrenceKey, snoozeActive, utcDate,
  type BaselineKind, type Completion, type TaskState, type TaskStatus,
} from './maintenance-status.ts';
import { latestKnownOdometer, type KnownOdometer } from './odometer.ts';
import {
  DEFAULT_MARKET, bundledPresets, importedTask, matchPresets, missingIdentity, presetTaskBody, similarTask, suggestedItems, type ExistingTask, type Preset,
} from './presets.ts';

type Q = Pick<pg.Pool, 'query'>;
export const TASK_FIELDS = ['name', 'catalogKey', 'recurring', 'intervalDays', 'intervalMonths', 'intervalDistance', 'firstDueOn', 'firstDueOdometer', 'notes',
  'presetId', 'presetVersion', 'presetTaskId', 'baselineKind', 'baselineOn', 'baselineOdometer', 'remindersEnabled', 'sourceTrust', 'sourceNote'] as const;
/** Provenance written only by applyPreset and export import; never by the public task bodies. */
export const PROVENANCE_FIELDS = ['presetId', 'presetVersion', 'presetTaskId', 'sourceTrust', 'sourceNote'] as const;
const PUBLIC_TASK_FIELDS = TASK_FIELDS.filter((k) => !(PROVENANCE_FIELDS as readonly string[]).includes(k));
const PATCH_FIELDS = [...PUBLIC_TASK_FIELDS, 'archived'] as const;
const SNOOZE_FIELDS = ['until', 'untilOdometer', 'additionalDistance', 'reason'] as const;
export const MAX_TASKS = 200;
const MAX_SNOOZE_DAYS = 3650;

interface TaskRow {
  id: Id; vehicle_id: Id; name: string; catalog_key: string | null; recurring: boolean; interval_days: number | null;
  interval_distance_input: string | null; interval_distance_unit: DistanceUnit | null; interval_distance_km: string | null;
  first_due_on: string | null; first_due_odometer_input: string | null; first_due_odometer_unit: DistanceUnit | null; first_due_odometer_km: string | null;
  notes: string | null; archived_at: Date | null; created_by: Id | null; created_at: Date; updated_at: Date;
  interval_months: number | null; preset_id: string | null; preset_version: number | null; preset_task_id: string | null;
  baseline_kind: BaselineKind | null; baseline_on: string | null; baseline_odometer_input: string | null; baseline_odometer_unit: DistanceUnit | null; baseline_odometer_km: string | null;
  reminders_enabled: boolean; source_trust: SourceTrust | null; source_note: string | null;
}
const COLS = `id, vehicle_id, name, catalog_key, recurring, interval_days, interval_distance_input::text, interval_distance_unit, interval_distance_km::text,
  first_due_on::text, first_due_odometer_input::text, first_due_odometer_unit, first_due_odometer_km::text, notes, archived_at, created_by, created_at, updated_at,
  interval_months, preset_id, preset_version, preset_task_id, baseline_kind, baseline_on::text, baseline_odometer_input::text, baseline_odometer_unit, baseline_odometer_km::text,
  reminders_enabled, source_trust, source_note`;
interface SnoozeDbRow { task_id: Id; scope: 'personal' | 'vehicle'; user_id: Id | null; until_date: string | null; until_km: string | null; reason: string | null; created_by: Id | null; created_at: Date }

interface Qty { value: string; unit: DistanceUnit; km: Dec }
export type SourceTrust = 'manufacturer' | 'community';
export interface ParsedTask {
  name: string; catalogKey: string | null; recurring: boolean; intervalDays: number | null; intervalMonths: number | null;
  intervalDistance: Qty | null; firstDueOn: string | null; firstDueOdometer: Qty | null; notes: string | null;
  preset: { id: string; version: number; taskId: string } | null;
  baseline: { kind: BaselineKind; on: string | null; odometer: Qty | null } | null;
  remindersEnabled: boolean; sourceTrust: SourceTrust | null; sourceNote: string | null;
}
export interface Distance { value: Decimal; unit: DistanceUnit }
export interface SnoozeView { scope: 'personal' | 'vehicle'; until: string | null; untilOdometer: Distance | null; reason: string | null; createdBy: Id | null; createdAt: string }
export interface TaskView {
  id: Id; vehicleId: Id; name: string; catalogKey: string | null; recurring: boolean; intervalDays: number | null;
  intervalDistance: Distance | null; firstDueOn: string | null; firstDueOdometer: Distance | null; notes: string | null; archived: boolean;
  createdBy: Id | null; createdAt: string; updatedAt: string;
  intervalMonths: number | null; presetId: string | null; presetVersion: number | null; presetTaskId: string | null;
  baselineKind: BaselineKind | null; baselineOn: string | null; baselineOdometer: Distance | null;
  remindersEnabled: boolean; sourceTrust: SourceTrust | null; sourceNote: string | null;
  /** Computed, never stored. See maintenance-status.ts for the rules. */
  status: TaskState; dueOn: string | null; dueOdometer: Distance | null; daysUntilDue: number | null; distanceUntilDue: Distance | null;
  baseline: TaskStatus['baseline']; distanceBaselineMissing: boolean; readingStale: boolean;
  lastCompleted: { visitId: Id; servicedOn: string; odometer: Distance | null } | null;
  /** The active snooze that applies to the caller (their personal one, else the vehicle-wide one); the original status stays visible. */
  snoozed: SnoozeView | null; snoozes: SnoozeView[]; reminderSuppressed: boolean; needsAttention: boolean;
}
export interface Evaluation { tasks: TaskView[]; reading: KnownOdometer | null; odometerUnit: DistanceUnit; distanceUnit: DistanceUnit; today: string }

const notFound = () => new HttpProblem(404, 'maintenance_task_not_found', 'Maintenance task not found');
const forbidden = (detail: string) => new HttpProblem(403, 'forbidden', 'Forbidden', detail);

/** Validate a complete task body. A recurring task repeats by an interval; a one-time task is due once, at a first-due date or odometer. */
export function parseTask(body: Record<string, unknown>, now: Date, trusted = false): ParsedTask {
  if (!trusted) { const bad = PROVENANCE_FIELDS.find((k) => k in body); if (bad) throw invalid(`Unknown field: ${bad}.`); }
  const catalogKey = body['catalogKey'] === undefined || body['catalogKey'] === null ? null : body['catalogKey'];
  if (catalogKey !== null && (typeof catalogKey !== 'string' || !catalogName(catalogKey))) throw invalid(`catalogKey must be one of ${CATALOG.map((c) => c.key).join(', ')}.`);
  const name = text(body['name'], 'name', 120, catalogKey === null) ?? catalogName(catalogKey as string)!;
  const recurring = body['recurring'] === undefined ? true : bool(body['recurring'], 'recurring');
  let intervalDays: number | null = null;
  if (body['intervalDays'] !== undefined && body['intervalDays'] !== null) {
    const n = body['intervalDays'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 36500) throw invalid('intervalDays must be a whole number of days from 1 to 36500.');
    intervalDays = n;
  }
  let intervalMonths: number | null = null;
  if (body['intervalMonths'] !== undefined && body['intervalMonths'] !== null) {
    const n = body['intervalMonths'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1200) throw invalid('intervalMonths must be a whole number of months from 1 to 1200.');
    intervalMonths = n;
  }
  if (intervalDays !== null && intervalMonths !== null) throw invalid('Give the time interval in intervalDays or in intervalMonths, not both.');
  const qty = (v: unknown, field: string, positive: boolean): Qty | null => {
    if (v === undefined || v === null) return null;
    const q = quantity(v, field, isDistanceUnit, 'km, mi', { maxScale: 3, max: '9999999', positive });
    return { value: q.value, unit: q.unit, km: toKm(q.dec, q.unit) };
  };
  const intervalDistance = qty(body['intervalDistance'], 'intervalDistance', true);
  const firstDueOdometer = qty(body['firstDueOdometer'], 'firstDueOdometer', false);
  let firstDueOn: string | null = null;
  if (body['firstDueOn'] !== undefined && body['firstDueOn'] !== null) {
    firstDueOn = dateOnly(body['firstDueOn'], 'firstDueOn');
    if (Number(firstDueOn.slice(0, 4)) < 1900) throw invalid('firstDueOn is too far in the past.');
    if (daysBetween(utcDate(now), firstDueOn) > 36500) throw invalid('firstDueOn is too far in the future.');
  }
  const baseline = parseBaseline(body, now, qty);
  if (recurring && intervalDays === null && intervalMonths === null && intervalDistance === null) throw invalid('A repeating task needs an interval in days or months, in distance, or both.');
  if (!recurring) {
    if (intervalDays !== null || intervalMonths !== null || intervalDistance !== null) throw invalid('A one-time task has no interval; set a due date or odometer instead.');
    if (firstDueOn === null && firstDueOdometer === null) throw invalid('A one-time task needs a due date or a due odometer.');
    if (baseline !== null) throw invalid('A one-time task has no baseline; record a visit that completes it instead.');
  }
  // Only an explicit true turns reminders on; a missing field means the default (on), null is refused.
  const remindersEnabled = body['remindersEnabled'] === undefined ? true : bool(body['remindersEnabled'], 'remindersEnabled');
  const st = body['sourceTrust'];
  if (st !== undefined && st !== null && st !== 'manufacturer' && st !== 'community') throw invalid("sourceTrust must be 'manufacturer' or 'community'.");
  return {
    name, catalogKey: catalogKey as string | null, recurring, intervalDays, intervalMonths, intervalDistance, firstDueOn, firstDueOdometer, notes: text(body['notes'], 'notes', 500),
    preset: parsePreset(body), baseline, remindersEnabled, sourceTrust: (st ?? null) as SourceTrust | null, sourceNote: text(body['sourceNote'], 'sourceNote', 300),
  };
}

const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,99}$/, PRESET_TASK_ID = /^[a-z0-9][a-z0-9_-]{0,99}$/;
/** Preset provenance: presetId, presetVersion and presetTaskId together, or none of them. */
function parsePreset(body: Record<string, unknown>): ParsedTask['preset'] {
  const id = body['presetId'] ?? null, version = body['presetVersion'] ?? null, taskId = body['presetTaskId'] ?? null;
  if (id === null && version === null && taskId === null) return null;
  if (id === null || version === null || taskId === null) throw invalid('presetId, presetVersion and presetTaskId go together: give all three or none.');
  if (typeof id !== 'string' || !PRESET_ID.test(id)) throw invalid('presetId must be a short lowercase id such as us-honda-odyssey-2015.');
  if (typeof taskId !== 'string' || !PRESET_TASK_ID.test(taskId)) throw invalid('presetTaskId must be a short lowercase id such as engine-oil.');
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 1_000_000) throw invalid('presetVersion must be a whole number from 1.');
  return { id, version, taskId };
}

/**
 * The task's own starting point. `reported`: when / at what odometer it was last
 * done, by the owner's word (scheduled like a completion). `tracking`: "start
 * tracking now", never a completion. Either needs a date, an odometer or both; neither may be in the future.
 */
function parseBaseline(body: Record<string, unknown>, now: Date, qty: (v: unknown, field: string, positive: boolean) => Qty | null): ParsedTask['baseline'] {
  const kind = body['baselineKind'] ?? null;
  let on: string | null = null;
  if (body['baselineOn'] !== undefined && body['baselineOn'] !== null) {
    on = dateOnly(body['baselineOn'], 'baselineOn');
    if (Number(on.slice(0, 4)) < 1900) throw invalid('baselineOn is too far in the past.');
    if (on > utcDate(now)) throw invalid('baselineOn must be today or earlier.');
  }
  const odometer = qty(body['baselineOdometer'], 'baselineOdometer', false);
  if (kind === null) {
    if (on !== null || odometer !== null) throw invalid("baselineOn and baselineOdometer need a baselineKind ('reported' or 'tracking').");
    return null;
  }
  if (kind !== 'reported' && kind !== 'tracking') throw invalid("baselineKind must be 'reported' or 'tracking'.");
  if (on === null && odometer === null) throw invalid('A baseline needs baselineOn, baselineOdometer, or both.');
  return { kind, on, odometer };
}

const dist = (input: string | null, unit: DistanceUnit | null): Distance | null => (input === null ? null : { value: input as Decimal, unit: unit! });
/** The columns added for presets, as they appear in views and exports. */
const provenance = (r: TaskRow) => ({
  intervalMonths: r.interval_months, presetId: r.preset_id, presetVersion: r.preset_version, presetTaskId: r.preset_task_id,
  baselineKind: r.baseline_kind, baselineOn: r.baseline_on, baselineOdometer: dist(r.baseline_odometer_input, r.baseline_odometer_unit),
  remindersEnabled: r.reminders_enabled, sourceTrust: r.source_trust, sourceNote: r.source_note,
});
const asView = (km: Dec, unit: DistanceUnit): Distance => ({ value: fromKm(km, unit).toFixed(0), unit });

/** Reject items that link to a task that does not belong to this vehicle (links are explicit and same-vehicle only). */
export async function assertTaskLinks(c: Q, vehicleId: Id, items: { taskId: Id | null }[]): Promise<void> {
  const ids = [...new Set(items.map((i) => i.taskId).filter((t): t is Id => t !== null))];
  if (!ids.length) return;
  const { rows } = await c.query<{ id: Id }>('SELECT id FROM maintenance_tasks WHERE vehicle_id = $1 AND id = ANY($2::uuid[])', [vehicleId, ids]);
  const ok = new Set(rows.map((r) => r.id));
  const at = items.findIndex((i) => i.taskId !== null && !ok.has(i.taskId));
  if (at >= 0) throw invalid(`items[${at}].taskId does not refer to a maintenance task of this vehicle.`);
}

/** Export-local labels (t1, t2, ...) for a vehicle's tasks in creation order; ids never leave the instance. */
export async function taskRefs(q: Q, vehicleId: Id): Promise<Map<Id, string>> {
  const { rows } = await q.query<{ id: Id }>('SELECT id FROM maintenance_tasks WHERE vehicle_id = $1 ORDER BY created_at, id', [vehicleId]);
  return new Map(rows.map((r, i) => [r.id, `t${i + 1}`]));
}

function viewOf(r: TaskRow, odometerUnit: DistanceUnit, distanceUnit: DistanceUnit, last: Completion & { visitId: Id; odometer: Distance | null } | null,
  snoozeRows: SnoozeDbRow[], reading: KnownOdometer | null, today: string): TaskView {
  const st = computeStatus({
    recurring: r.recurring, intervalDays: r.interval_days, intervalMonths: r.interval_months, intervalDistanceKm: r.interval_distance_km === null ? null : Dec.parse(r.interval_distance_km),
    firstDueOn: r.first_due_on, firstDueOdometerKm: r.first_due_odometer_km === null ? null : Dec.parse(r.first_due_odometer_km),
    baseline: r.baseline_kind === null ? null : { kind: r.baseline_kind, on: r.baseline_on, odometerKm: r.baseline_odometer_km === null ? null : Dec.parse(r.baseline_odometer_km) },
  }, last, reading, today, distanceUnit);
  const rows = snoozeRows.map((s) => ({ scope: s.scope, untilDate: s.until_date, untilOdometerKm: s.until_km === null ? null : Dec.parse(s.until_km), src: s }));
  const snoozes: SnoozeView[] = effectiveSnoozes(rows, today, reading).map(({ scope, untilDate, untilOdometerKm, src }) => ({
    scope, until: untilDate, untilOdometer: untilOdometerKm === null ? null : asView(untilOdometerKm, odometerUnit), reason: src.reason, createdBy: src.created_by, createdAt: src.created_at.toISOString(),
  }));
  return {
    id: r.id, vehicleId: r.vehicle_id, name: r.name, catalogKey: r.catalog_key, recurring: r.recurring, intervalDays: r.interval_days,
    intervalDistance: dist(r.interval_distance_input, r.interval_distance_unit), firstDueOn: r.first_due_on, firstDueOdometer: dist(r.first_due_odometer_input, r.first_due_odometer_unit),
    notes: r.notes, archived: r.archived_at !== null, createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    ...provenance(r),
    status: st.state, dueOn: st.dueOn, dueOdometer: st.dueOdometerKm === null ? null : asView(st.dueOdometerKm, odometerUnit), daysUntilDue: st.daysUntilDue,
    distanceUntilDue: st.distanceUntilDueKm === null ? null : asView(st.distanceUntilDueKm, odometerUnit),
    baseline: st.baseline, distanceBaselineMissing: st.distanceBaselineMissing, readingStale: st.readingStale,
    lastCompleted: last ? { visitId: last.visitId, servicedOn: last.servicedOn, odometer: last.odometer } : null,
    snoozed: snoozes[0] ?? null, snoozes, reminderSuppressed: snoozes.length > 0, needsAttention: needsAttention(st.state),
  };
}

/**
 * Tasks of one vehicle with their computed status, as one person sees them:
 * their personal snooze and the vehicle-wide one. No authorization or module
 * check (callers have done theirs). `taskId` narrows to one task.
 */
export async function evaluateTasks(q: Q, vehicleId: Id, userId: Id, now: Date, o: { taskId?: Id; includeArchived?: boolean } = {}): Promise<Evaluation> {
  const today = utcDate(now);
  const [veh, prefs, reading] = await Promise.all([
    q.query<{ odometer_unit: DistanceUnit }>('SELECT odometer_unit FROM vehicles WHERE id = $1', [vehicleId]),
    getPreferences(q, userId), latestKnownOdometer(q, vehicleId),
  ]);
  const odometerUnit = veh.rows[0]?.odometer_unit ?? 'km';
  const { rows } = await q.query<TaskRow>(
    `SELECT ${COLS} FROM maintenance_tasks WHERE vehicle_id = $1 AND ($2::uuid IS NULL OR id = $2) AND ($3 OR archived_at IS NULL) ORDER BY created_at, id`,
    [vehicleId, o.taskId ?? null, o.includeArchived ?? false]);
  const ids = rows.map((r) => r.id);
  const lastRows = ids.length ? (await q.query<{ task_id: Id; visit_id: Id; serviced_on: string; odometer_km: string | null; odometer_input: string | null; odometer_unit: DistanceUnit | null }>(
    `SELECT DISTINCT ON (i.task_id) i.task_id, v.id AS visit_id, v.serviced_on::text, v.odometer_km::text, v.odometer_input::text, v.odometer_unit
       FROM service_items i JOIN service_visits v ON v.id = i.visit_id
      WHERE v.vehicle_id = $1 AND i.task_id = ANY($2::uuid[])
      ORDER BY i.task_id, v.serviced_on DESC, v.created_at DESC, v.id DESC`, [vehicleId, ids])).rows : [];
  const snoozeRows = ids.length ? (await q.query<SnoozeDbRow>(
    `SELECT task_id, scope, user_id, snooze_until_date::text AS until_date, snooze_until_odometer_km::text AS until_km, reason, created_by, created_at
       FROM task_snoozes WHERE task_id = ANY($1::uuid[]) AND (scope = 'vehicle' OR user_id = $2)`, [ids, userId])).rows : [];
  const lastBy = new Map(lastRows.map((l) => [l.task_id, { visitId: l.visit_id, servicedOn: l.serviced_on, odometerKm: l.odometer_km === null ? null : Dec.parse(l.odometer_km), odometer: dist(l.odometer_input, l.odometer_unit) }]));
  const tasks = rows.map((r) => viewOf(r, odometerUnit, prefs.distanceUnit, lastBy.get(r.id) ?? null, snoozeRows.filter((s) => s.task_id === r.id), reading, today));
  return { tasks, reading, odometerUnit, distanceUnit: prefs.distanceUnit, today };
}

/**
 * For notifications: the vehicle's unarchived tasks with reminders enabled that
 * are due soon or overdue, each with the person's effective snooze (`reminderSuppressed`). The
 * caller decides what to do with suppressed ones; they are included so a
 * digest can still list them as muted. Does not check the module switch or membership.
 */
export async function tasksNeedingAttention(q: Q, vehicleId: Id, userId: Id, now: Date = new Date()): Promise<TaskView[]> {
  return (await evaluateTasks(q, vehicleId, userId, now)).tasks.filter((t) => t.needsAttention && t.remindersEnabled);
}

/**
 * When a task's reminders are turned on: record its current due state as
 * already announced for every member who could receive reminders (whatever the
 * vehicle's email switch), each evaluated as they see it (lead distance and
 * snoozes are per person). So opting in never sends a backlog or catch-up email;
 * a later level (due soon to overdue), a new due point or a follow-up still does.
 */
export async function seedReminderLedger(q: Q, vehicleId: Id, taskId: Id, now: Date): Promise<void> {
  const { rows } = await q.query<{ user_id: Id }>('SELECT user_id FROM vehicle_members WHERE vehicle_id = $1 AND role = ANY($2::text[])', [vehicleId, EMAIL_RECIPIENT_ROLES]);
  for (const { user_id } of rows) {
    const t = (await evaluateTasks(q, vehicleId, user_id, now, { taskId })).tasks[0];
    if (!t || !t.needsAttention) continue;
    await q.query(
      `INSERT INTO notification_task_log (user_id, task_id, vehicle_id, occurrence_key, level, first_notified_at, last_bucket, sends, muted)
       VALUES ($1,$2,$3,$4,$5,$6,0,1,false) ON CONFLICT (user_id, task_id, occurrence_key, level) DO NOTHING`,
      [user_id, taskId, vehicleId, occurrenceKey(t), t.status, now]);
  }
}

// ---------- import / export (no module check: data stays portable while the module is off) ----------
export interface TaskExport {
  ref: string; name: string; catalogKey: string | null; recurring: boolean; intervalDays: number | null; intervalDistance: Distance | null;
  firstDueOn: string | null; firstDueOdometer: Distance | null; notes: string | null; archived: boolean;
  intervalMonths: number | null; presetId: string | null; presetVersion: number | null; presetTaskId: string | null;
  baselineKind: BaselineKind | null; baselineOn: string | null; baselineOdometer: Distance | null;
  remindersEnabled: boolean; sourceTrust: SourceTrust | null; sourceNote: string | null;
  /** Vehicle-wide snooze only, and only while active. Personal snoozes are never exported. */
  snooze?: { until: string | null; untilOdometer: Distance | null; reason: string | null };
}

export async function exportTasks(q: Q, vehicleId: Id, now: Date): Promise<TaskExport[]> {
  const [{ rows }, reading, snz] = await Promise.all([
    q.query<TaskRow>(`SELECT ${COLS} FROM maintenance_tasks WHERE vehicle_id = $1 ORDER BY created_at, id`, [vehicleId]),
    latestKnownOdometer(q, vehicleId),
    q.query<SnoozeDbRow>(`SELECT s.task_id, s.scope, s.user_id, s.snooze_until_date::text AS until_date, s.snooze_until_odometer_km::text AS until_km, s.reason, s.created_by, s.created_at
      FROM task_snoozes s JOIN maintenance_tasks t ON t.id = s.task_id WHERE t.vehicle_id = $1 AND s.scope = 'vehicle'`, [vehicleId]),
  ]);
  const today = utcDate(now);
  return rows.map((r, i): TaskExport => {
    const s = snz.rows.find((x) => x.task_id === r.id);
    const active = s && snoozeActive({ scope: 'vehicle', untilDate: s.until_date, untilOdometerKm: s.until_km === null ? null : Dec.parse(s.until_km) }, today, reading);
    return {
      ref: `t${i + 1}`, name: r.name, catalogKey: r.catalog_key, recurring: r.recurring, intervalDays: r.interval_days,
      intervalDistance: dist(r.interval_distance_input, r.interval_distance_unit), firstDueOn: r.first_due_on, firstDueOdometer: dist(r.first_due_odometer_input, r.first_due_odometer_unit),
      notes: r.notes, archived: r.archived_at !== null, ...provenance(r),
      ...(s && active ? { snooze: { until: s.until_date, untilOdometer: s.until_km === null ? null : { value: Dec.parse(s.until_km).toFixed(3), unit: 'km' as const }, reason: s.reason } } : {}),
    };
  });
}

export const TASK_EXPORT_FIELDS = ['ref', ...TASK_FIELDS, 'archived', 'snooze'] as const;

export interface ParsedImportTask { ref: string | null; f: ParsedTask; archived: boolean; snooze: { untilDate: string | null; untilKm: Dec | null; reason: string | null } | null }

export function parseImportTask(raw: unknown, now: Date): ParsedImportTask {
  const b = obj(raw, TASK_EXPORT_FIELDS, 'Maintenance task');
  const { ref, archived, snooze, ...rest } = b;
  if (ref !== undefined && (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(ref))) throw invalid('ref must be a short label such as t1.');
  if (archived !== undefined && typeof archived !== 'boolean') throw invalid('archived must be true or false.');
  let sn: ParsedImportTask['snooze'] = null;
  if (snooze !== undefined && snooze !== null) {
    const s = obj(snooze, ['until', 'untilOdometer', 'reason'], 'snooze');
    const untilDate = s['until'] === undefined || s['until'] === null ? null : dateOnly(s['until'], 'snooze.until');
    const q = s['untilOdometer'] === undefined || s['untilOdometer'] === null ? null : quantity(s['untilOdometer'], 'snooze.untilOdometer', isDistanceUnit, 'km, mi', { maxScale: 3, max: '9999999' });
    if (untilDate === null && q === null) throw invalid('snooze needs until or untilOdometer.');
    sn = { untilDate, untilKm: q ? toKm(q.dec, q.unit) : null, reason: text(s['reason'], 'snooze.reason', 200) };
  }
  return { ref: (ref as string | undefined) ?? null, f: parseTask(rest, now, true), archived: archived === true, snooze: sn };
}

const INTERVAL_FIELDS = ['intervalDays', 'intervalMonths', 'intervalDistance'] as const;
/** Same interval? Distances compare by value and unit; absent and null are the same. */
function sameInterval(a: unknown, b: unknown): boolean {
  const norm = (x: unknown) => (x === undefined || x === null ? null : typeof x === 'object' ? { value: Dec.parse(String((x as { value: unknown }).value)).toFixed(6), unit: (x as { unit: unknown }).unit } : x);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Values of the preset-era columns, in the order of EXTRA_COLS. */
const EXTRA_COLS = ['interval_months', 'preset_id', 'preset_version', 'preset_task_id', 'baseline_kind', 'baseline_on', 'baseline_odometer_input', 'baseline_odometer_unit',
  'baseline_odometer_km', 'reminders_enabled', 'source_trust', 'source_note'] as const;
const extraValues = (f: ParsedTask): unknown[] => [
  f.intervalMonths, f.preset?.id ?? null, f.preset?.version ?? null, f.preset?.taskId ?? null, f.baseline?.kind ?? null, f.baseline?.on ?? null,
  f.baseline?.odometer?.value ?? null, f.baseline?.odometer?.unit ?? null, f.baseline?.odometer?.km.toFixed(6) ?? null, f.remindersEnabled, f.sourceTrust, f.sourceNote,
];

/** A second task from the same preset task on one vehicle (unique index): a conflict, not a server error. */
async function presetConflict<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23505' && err.constraint === 'maintenance_tasks_preset_idx') {
      throw new HttpProblem(409, 'maintenance_task_preset_exists', 'Conflict', 'This vehicle already has a task made from that preset task.');
    }
    throw e;
  }
}

export async function insertTask(c: Q, vehicleId: Id, f: ParsedTask, createdBy: Id, archived = false): Promise<Id> {
  const id = uuidv7();
  await presetConflict(() => c.query(
    `INSERT INTO maintenance_tasks (id, vehicle_id, name, catalog_key, recurring, interval_days, interval_distance_input, interval_distance_unit, interval_distance_km,
       first_due_on, first_due_odometer_input, first_due_odometer_unit, first_due_odometer_km, notes, archived_at, created_by, ${EXTRA_COLS.join(', ')})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,${EXTRA_COLS.map((_, i) => `$${17 + i}`).join(',')})`,
    [id, vehicleId, f.name, f.catalogKey, f.recurring, f.intervalDays, f.intervalDistance?.value ?? null, f.intervalDistance?.unit ?? null, f.intervalDistance?.km.toFixed(6) ?? null,
      f.firstDueOn, f.firstDueOdometer?.value ?? null, f.firstDueOdometer?.unit ?? null, f.firstDueOdometer?.km.toFixed(6) ?? null, f.notes, archived ? new Date() : null, createdBy,
      ...extraValues(f)]));
  return id;
}

/**
 * The id of the task already on the vehicle that this one duplicates, used to
 * skip duplicates on import: for a preset task, the task made from the same
 * preset task (whatever was customised since); otherwise an identical task
 * (same name, schedule and first-due point).
 */
export async function findDuplicateTask(c: Q, vehicleId: Id, f: ParsedTask): Promise<Id | null> {
  if (f.preset) {
    const { rows } = await c.query<{ id: Id }>('SELECT id FROM maintenance_tasks WHERE vehicle_id = $1 AND preset_id = $2 AND preset_task_id = $3', [vehicleId, f.preset.id, f.preset.taskId]);
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await c.query<{ id: Id }>(
    `SELECT id FROM maintenance_tasks WHERE vehicle_id = $1 AND lower(name) = lower($2) AND catalog_key IS NOT DISTINCT FROM $3 AND recurring = $4
        AND interval_days IS NOT DISTINCT FROM $5 AND interval_months IS NOT DISTINCT FROM $9 AND interval_distance_km IS NOT DISTINCT FROM $6::numeric
        AND first_due_on IS NOT DISTINCT FROM $7::date AND first_due_odometer_km IS NOT DISTINCT FROM $8::numeric ORDER BY created_at LIMIT 1`,
    [vehicleId, f.name, f.catalogKey, f.recurring, f.intervalDays, f.intervalDistance?.km.toFixed(6) ?? null, f.firstDueOn, f.firstDueOdometer?.km.toFixed(6) ?? null, f.intervalMonths]);
  return rows[0]?.id ?? null;
}

export async function insertVehicleSnooze(c: Q, taskId: Id, s: { untilDate: string | null; untilKm: Dec | null; reason: string | null }, createdBy: Id): Promise<void> {
  await c.query("INSERT INTO task_snoozes (id, task_id, scope, user_id, snooze_until_date, snooze_until_odometer_km, reason, created_by) VALUES ($1,$2,'vehicle',NULL,$3,$4,$5,$6)",
    [uuidv7(), taskId, s.untilDate, s.untilKm?.toFixed(6) ?? null, s.reason, createdBy]);
}

// ---------- service ----------
export class MaintenanceService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #now: () => Date;
  readonly #presets: readonly Preset[];
  constructor(pool: pg.Pool, vehicles: VehicleService, now: () => Date = () => new Date(), presets: readonly Preset[] = bundledPresets()) {
    this.#pool = pool; this.#vehicles = vehicles; this.#now = now; this.#presets = presets;
  }

  /** Names only: DriveLoom ships no manufacturer intervals. The lead thresholds are illustrative defaults, not safety guidance. */
  async catalog(p: Principal): Promise<{ items: { key: string; name: string }[]; defaults: { leadDays: number; leadDistance: Distance; staleReadingDays: number } }> {
    await requireModule(this.#pool, 'service');
    const { distanceUnit } = await getPreferences(this.#pool, p.userId);
    return { items: CATALOG.map((c) => ({ key: c.key, name: c.name })), defaults: { leadDays: LEAD_DAYS, leadDistance: { value: String(LEAD_DISTANCE) as Decimal, unit: distanceUnit }, staleReadingDays: STALE_READING_DAYS } };
  }

  async list(p: Principal, vehicleId: unknown, o: { includeArchived?: boolean } = {}): Promise<{ items: TaskView[] }> {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    return { items: (await evaluateTasks(this.#pool, v.id, p.userId, this.#now(), o)).tasks };
  }

  async get(p: Principal, vehicleId: unknown, taskId: unknown): Promise<TaskView> {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    return this.#one(this.#pool, v, p, taskId);
  }

  async #one(q: Q, v: VehicleAccess, p: Principal, taskId: unknown): Promise<TaskView> {
    if (!isUuid(taskId)) throw notFound();
    const t = (await evaluateTasks(q, v.id, p.userId, this.#now(), { taskId, includeArchived: true })).tasks[0];
    if (!t) throw notFound();
    return t;
  }

  /** Counts for the Service page header. Archived tasks are not counted. */
  async summary(p: Principal, vehicleId: unknown) {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    const e = await evaluateTasks(this.#pool, v.id, p.userId, this.#now());
    const counts = { total: e.tasks.length, overdue: 0, due_soon: 0, ok: 0, no_baseline: 0, unknown_reading: 0, completed: 0, snoozed: 0, needsAttention: 0, remindersActive: 0 };
    for (const t of e.tasks) {
      counts[t.status]++;
      if (t.snoozed) counts.snoozed++;
      if (t.needsAttention) { counts.needsAttention++; if (!t.reminderSuppressed && t.remindersEnabled) counts.remindersActive++; }
    }
    return {
      counts,
      reading: e.reading ? { odometer: asView(e.reading.km, e.odometerUnit), on: e.reading.on, source: e.reading.source, stale: daysBetween(e.reading.on, e.today) > STALE_READING_DAYS } : null,
      defaults: { leadDays: LEAD_DAYS, leadDistance: { value: String(LEAD_DISTANCE) as Decimal, unit: e.distanceUnit }, staleReadingDays: STALE_READING_DAYS },
    };
  }

  /** One transaction with the vehicle row locked. `rollback` runs everything (validation included) and then discards it: a preview. */
  async #write<T>(p: Principal, vehicleId: unknown, fn: (c: pg.PoolClient, v: VehicleAccess) => Promise<T>, allow: (role: VehicleAccess['role']) => string | null, o: { rollback?: boolean } = {}): Promise<T> {
    await requireModule(this.#pool, 'service');
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      const denied = allow(v.role);
      if (denied) throw forbidden(denied);
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived. Unarchive it to change its records.');
      const out = await fn(c, v);
      await c.query(o.rollback ? 'ROLLBACK' : 'COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async #audit(c: pg.PoolClient, p: Principal, action: string, vehicleId: Id, details: Record<string, unknown>): Promise<void> {
    const taskId = typeof details['taskId'] === 'string' ? [details['taskId'] as Id] : [];
    await auditAs(c, p, { action, subjectType: 'vehicle', subjectId: vehicleId, details, ...(taskId.length ? { target: { type: 'maintenance_task', ids: taskId } } : {}) });
  }
  readonly #manage = (role: VehicleAccess['role']) => (canManageSchedules(role) ? null : 'Your role does not allow changing maintenance tasks.');

  /** `idem` (an API key's Idempotency-Key): the same key and payload again returns the first outcome without writing. */
  async create(p: Principal, vehicleId: unknown, body: unknown, idem?: Idem): Promise<TaskView> {
    const b = obj(body, PUBLIC_TASK_FIELDS);
    return this.#write(p, vehicleId, (c, v) => withIdempotency(c, p, idem, { operation: 'maintenance_task.create', target: v.id, payload: b, now: this.#now(), reference: (r) => r.id, reread: (id) => this.#one(c, v, p, id) }, async () => {
      const f = parseTask(b, this.#now());
      const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM maintenance_tasks WHERE vehicle_id = $1', [v.id])).rows[0]!.n);
      if (n >= MAX_TASKS) throw invalid(`A vehicle allows at most ${MAX_TASKS} maintenance tasks.`);
      const id = await insertTask(c, v.id, f, p.userId);
      await this.#audit(c, p, 'maintenance_task.create', v.id, { taskId: id });
      return this.#one(c, v, p, id);
    }), this.#manage);
  }

  /** Partial update: the stored task is merged with the patch and validated again as a whole. `archived` hides a task without deleting it. */
  async update(p: Principal, vehicleId: unknown, taskId: unknown, body: unknown): Promise<TaskView> {
    const patch = obj(body, PATCH_FIELDS);
    if (!Object.keys(patch).length) throw invalid('At least one field is required.');
    if ('archived' in patch) bool(patch['archived'], 'archived');
    return this.#write(p, vehicleId, async (c, v) => {
      const cur = await this.#one(c, v, p, taskId);
      const { archived, ...fields } = patch;
      const merged = Object.fromEntries(TASK_FIELDS.map((k) => [k, k in fields ? fields[k] : cur[k]]));
      const f = parseTask(merged, this.#now(), true);
      // An interval the owner changed is theirs, not the preset's: it loses the trust label (note and provenance stay).
      if (f.sourceTrust !== null && INTERVAL_FIELDS.some((k) => k in fields && !sameInterval(fields[k], cur[k]))) f.sourceTrust = null;
      await presetConflict(() => c.query(
        `UPDATE maintenance_tasks SET name = $2, catalog_key = $3, recurring = $4, interval_days = $5, interval_distance_input = $6, interval_distance_unit = $7, interval_distance_km = $8,
           first_due_on = $9, first_due_odometer_input = $10, first_due_odometer_unit = $11, first_due_odometer_km = $12, notes = $13,
           archived_at = CASE WHEN $14::boolean IS NULL THEN archived_at WHEN $14 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now(),
           ${EXTRA_COLS.map((col, i) => `${col} = $${15 + i}`).join(', ')} WHERE id = $1`,
        [cur.id, f.name, f.catalogKey, f.recurring, f.intervalDays, f.intervalDistance?.value ?? null, f.intervalDistance?.unit ?? null, f.intervalDistance?.km.toFixed(6) ?? null,
          f.firstDueOn, f.firstDueOdometer?.value ?? null, f.firstDueOdometer?.unit ?? null, f.firstDueOdometer?.km.toFixed(6) ?? null, f.notes, archived === undefined ? null : archived,
          ...extraValues(f)]));
      // Opting in to reminders starts from now: what is already due counts as announced.
      if (!cur.remindersEnabled && f.remindersEnabled) await seedReminderLedger(c, v.id, cur.id, this.#now());
      await this.#audit(c, p, 'maintenance_task.update', v.id, { taskId: cur.id, ...(cur.remindersEnabled !== f.remindersEnabled ? { remindersEnabled: f.remindersEnabled } : {}) });
      return this.#one(c, v, p, cur.id);
    }, this.#manage);
  }

  /** Deletes the task and its snoozes; service items that completed it are kept and simply lose the link. */
  async remove(p: Principal, vehicleId: unknown, taskId: unknown): Promise<void> {
    await this.#write(p, vehicleId, async (c, v) => {
      if (!isUuid(taskId)) throw notFound();
      if (!(await c.query('DELETE FROM maintenance_tasks WHERE id = $1 AND vehicle_id = $2', [taskId, v.id])).rowCount) throw notFound();
      await this.#audit(c, p, 'maintenance_task.delete', v.id, { taskId });
    }, this.#manage);
  }

  /**
   * Set or replace the caller's personal snooze (scope `personal`, any member) or
   * the vehicle-wide one (scope `vehicle`, owner or editor). Mutes reminders only.
   * `additionalDistance` is converted once, here, to an absolute odometer target
   * from the latest known reading (422 `no_odometer_reading` when there is none);
   * that absolute target is what is stored.
   */
  async setSnooze(p: Principal, vehicleId: unknown, taskId: unknown, scope: unknown, body: unknown): Promise<TaskView> {
    const sc = parseScope(scope);
    const b = obj(body, SNOOZE_FIELDS);
    return this.#write(p, vehicleId, async (c, v) => {
      const cur = await this.#one(c, v, p, taskId);
      const today = utcDate(this.#now());
      let untilDate: string | null = null, untilKm: Dec | null = null;
      if (b['until'] !== undefined && b['until'] !== null) {
        untilDate = dateOnly(b['until'], 'until');
        if (untilDate < today) throw invalid('until must be today or later.');
        if (daysBetween(today, untilDate) > MAX_SNOOZE_DAYS) throw invalid('until is too far in the future.');
      }
      const hasAbs = b['untilOdometer'] !== undefined && b['untilOdometer'] !== null, hasAdd = b['additionalDistance'] !== undefined && b['additionalDistance'] !== null;
      if (hasAbs && hasAdd) throw invalid('Give either untilOdometer or additionalDistance, not both.');
      if (untilDate === null && !hasAbs && !hasAdd) throw invalid('Give until, untilOdometer or additionalDistance.');
      if (hasAbs || hasAdd) {
        const reading = await latestKnownOdometer(c, v.id);
        if (hasAdd) {
          const q = quantity(b['additionalDistance'], 'additionalDistance', isDistanceUnit, 'km, mi', { maxScale: 3, max: '99999', positive: true });
          if (!reading) throw new HttpProblem(422, 'no_odometer_reading', 'Validation failed', 'No odometer reading is known for this vehicle yet, so a distance snooze cannot be worked out. Pick a date, or enter an odometer to snooze until.');
          untilKm = reading.km.add(toKm(q.dec, q.unit));
        } else {
          const q = quantity(b['untilOdometer'], 'untilOdometer', isDistanceUnit, 'km, mi', { maxScale: 3, max: '9999999' });
          untilKm = toKm(q.dec, q.unit);
          if (reading && untilKm.cmp(reading.km) <= 0) throw invalid('untilOdometer is not above the latest known odometer reading, so it would end at once.');
        }
      }
      const reason = text(b['reason'], 'reason', 200);
      const userId = sc === 'personal' ? p.userId : null;
      await c.query('DELETE FROM task_snoozes WHERE task_id = $1 AND scope = $2 AND user_id IS NOT DISTINCT FROM $3', [cur.id, sc, userId]);
      await c.query('INSERT INTO task_snoozes (id, task_id, scope, user_id, snooze_until_date, snooze_until_odometer_km, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uuidv7(), cur.id, sc, userId, untilDate, untilKm?.toFixed(6) ?? null, reason, p.userId]);
      await this.#audit(c, p, 'maintenance_snooze.set', v.id, { taskId: cur.id, scope: sc });
      return this.#one(c, v, p, cur.id);
    }, (role) => (sc === 'vehicle' && !canManageSchedules(role) ? 'Only owners and managers can snooze a task for everyone.' : null));
  }

  async clearSnooze(p: Principal, vehicleId: unknown, taskId: unknown, scope: unknown): Promise<TaskView> {
    const sc = parseScope(scope);
    return this.#write(p, vehicleId, async (c, v) => {
      const cur = await this.#one(c, v, p, taskId);
      const n = (await c.query('DELETE FROM task_snoozes WHERE task_id = $1 AND scope = $2 AND user_id IS NOT DISTINCT FROM $3', [cur.id, sc, sc === 'personal' ? p.userId : null])).rowCount;
      if (n) await this.#audit(c, p, 'maintenance_snooze.clear', v.id, { taskId: cur.id, scope: sc });
      return this.#one(c, v, p, cur.id);
    }, (role) => (sc === 'vehicle' && !canManageSchedules(role) ? 'Only owners and managers can clear a snooze for everyone.' : null));
  }

  // ---------- presets ----------

  /**
   * Presets matching this vehicle (normalised make and model, year, market), each
   * task annotated with what the vehicle already has: the task made from it
   * (`alreadyImported`), a similar typed-in task (`existingTaskMatch`) and
   * unlinked service items that might be its last completion. Read-only; any member.
   */
  async presets(p: Principal, vehicleId: unknown, market: unknown): Promise<PresetList> {
    await requireModule(this.#pool, 'service');
    const mk = parseMarket(market);
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    const veh = (await this.#pool.query<{ make: string | null; model: string | null; model_year: number | null }>('SELECT make, model, model_year FROM vehicles WHERE id = $1', [v.id])).rows[0]!;
    const ident = { make: veh.make, model: veh.model, year: veh.model_year };
    const missing = missingIdentity(ident);
    const matches = matchPresets(this.#presets, ident, mk);
    const out: PresetList = { market: mk, vehicle: ident, missing, canApply: canManageSchedules(v.role) && !v.archived, items: [] };
    if (!matches.length) return out;
    const [tasks, items] = await Promise.all([existingTasks(this.#pool, v.id), this.#pool.query<{ id: Id; name: string; visit_id: Id; serviced_on: string; odometer_input: string | null; odometer_unit: DistanceUnit | null }>(
      `SELECT i.id, i.name, v.id AS visit_id, v.serviced_on::text, v.odometer_input::text, v.odometer_unit
         FROM service_items i JOIN service_visits v ON v.id = i.visit_id
        WHERE v.vehicle_id = $1 AND i.task_id IS NULL ORDER BY v.serviced_on DESC, v.created_at DESC, i.position LIMIT 1000`, [v.id])]);
    out.items = matches.map((pr) => ({
      id: pr.id, version: pr.version, market: pr.market, make: pr.make, model: pr.model, year: pr.year ?? null, yearRange: pr.yearRange ?? null,
      reviewedOn: pr.reviewedOn, sources: pr.sources.map((s) => ({ title: s.title, url: s.url, kind: s.kind, note: s.note ?? null })),
      needsQualifier: pr.variants ?? [],
      tasks: pr.tasks.map((t) => {
        const done = importedTask(tasks, pr.id, t.id), similar = done ? null : similarTask(tasks, t);
        return {
          id: t.id, name: t.name, catalogKey: t.catalogKey ?? null, description: t.description,
          rule: { months: t.rule.months ?? null, distance: t.rule.distance ?? null }, trust: t.trust, sourceNote: t.sourceNote, severity: t.severity ?? null,
          alreadyImported: done ? { taskId: done.id, name: done.name, presetVersion: done.preset_version!, archived: done.archived } : null,
          existingTaskMatch: similar ? { taskId: similar.task.id, name: similar.task.name, matchedBy: similar.matchedBy } : null,
          suggestedServiceItems: done ? [] : suggestedItems(items.rows, t).map((i) => ({ id: i.id, name: i.name, visitId: i.visit_id, servicedOn: i.serviced_on, odometer: dist(i.odometer_input, i.odometer_unit) })),
        };
      }),
    }));
    return out;
  }

  /**
   * Turns the selected preset tasks into ordinary tasks of this vehicle, in one
   * transaction: all or nothing. Each new task carries the preset provenance and
   * trust label, starts with email reminders off, and gets the interval from the
   * preset or the owner's override and the baseline the owner chose. Nothing
   * touches odometer or fuel data and nothing is sent. A task this vehicle already
   * made from the same preset task is skipped (never duplicated or overwritten);
   * a similar typed-in task is skipped, or with onDuplicate `link` gets only the
   * provenance attached. `preview` does all of it, reports the resulting status,
   * and rolls back.
   */
  async applyPreset(p: Principal, vehicleId: unknown, presetId: unknown, body: unknown, preview: boolean): Promise<PresetApplyResult> {
    const b = obj(body, ['variant', 'tasks']);
    return this.#write(p, vehicleId, async (c, v) => {
      const pr = this.#presets.find((x) => x.id === presetId);
      if (!pr) throw new HttpProblem(404, 'maintenance_preset_not_found', 'Maintenance preset not found');
      const veh = (await c.query<{ make: string | null; model: string | null; model_year: number | null; odometer_unit: DistanceUnit }>(
        'SELECT make, model, model_year, odometer_unit FROM vehicles WHERE id = $1', [v.id])).rows[0]!;
      if (!matchPresets([pr], { make: veh.make, model: veh.model, year: veh.model_year }, pr.market).length) {
        throw new HttpProblem(422, 'maintenance_preset_not_applicable', 'Validation failed', "This preset does not match the vehicle's make, model and year.");
      }
      const variant = parseVariant(pr, b['variant']);
      const sel = parseSelection(pr, b['tasks']);
      // Effects, from the request alone (never from stored data) and before anything is written, so a preview and the commit
      // it previews need exactly the same grants (D5). maintenance.create is the route's rule; service.read and fuel.read come with it.
      if (sel.some((s) => s.onDuplicate === 'link')) requireKeyGrant(p, { module: 'maintenance', action: 'update' });
      if (sel.some((s) => s.baseline.kind === 'reported' && s.baseline.linkServiceItemId !== undefined)) requireKeyGrant(p, { module: 'service', action: 'update' });
      const now = this.#now(), today = utcDate(now);
      const reading = await latestKnownOdometer(c, v.id);
      const rows = await existingTasks(c, v.id);
      let count = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM maintenance_tasks WHERE vehicle_id = $1', [v.id])).rows[0]!.n);
      const linkedTasks = new Set<Id>(), linkedItems = new Set<Id>();
      const results: { presetTaskId: string; result: 'created' | 'linked' | 'skipped'; reason: string | null; taskId: Id; created: boolean }[] = [];
      for (const [i, s] of sel.entries()) {
        const t = pr.tasks.find((x) => x.id === s.presetTaskId)!;
        const done = importedTask(rows, pr.id, t.id);
        if (done) { results.push({ presetTaskId: t.id, result: 'skipped', reason: 'already_imported', taskId: done.id, created: false }); continue; }
        const similar = similarTask(rows.filter((r) => !linkedTasks.has(r.id)), t);
        if (similar) {
          if (s.onDuplicate === 'link') {
            // Provenance only: the owner's interval, baseline, reminders, notes and snoozes stay exactly as they were.
            await presetConflict(() => c.query('UPDATE maintenance_tasks SET preset_id = $2, preset_version = $3, preset_task_id = $4, updated_at = now() WHERE id = $1',
              [similar.task.id, pr.id, pr.version, t.id]));
            linkedTasks.add(similar.task.id);
            results.push({ presetTaskId: t.id, result: 'linked', reason: 'existing_task', taskId: similar.task.id, created: false });
          } else results.push({ presetTaskId: t.id, result: 'skipped', reason: 'existing_task', taskId: similar.task.id, created: false });
          continue;
        }
        const at = `tasks[${i}]`;
        const draft: Record<string, unknown> = presetTaskBody(pr, t);
        if (s.overrides) {
          for (const k of ['intervalMonths', 'intervalDistance'] as const) if (k in s.overrides) draft[k] = s.overrides[k];
          // An interval the owner changed is theirs, not the preset's: it loses the trust label.
          if (JSON.stringify([draft['intervalMonths'], draft['intervalDistance']]) !== JSON.stringify([t.rule.months ?? null, t.rule.distance ?? null])) draft['sourceTrust'] = null;
        }
        if (s.baseline.kind === 'tracking') {
          // "Start tracking now": today, plus the latest known odometer when it is recent. Copied, never written back.
          draft['baselineKind'] = 'tracking'; draft['baselineOn'] = today;
          if (reading && daysBetween(reading.on, today) <= STALE_READING_DAYS) draft['baselineOdometer'] = { value: fromKm(reading.km, veh.odometer_unit).toFixed(0), unit: veh.odometer_unit };
        } else if (s.baseline.kind === 'reported' && (s.baseline.on !== undefined || s.baseline.odometer !== undefined)) {
          draft['baselineKind'] = 'reported'; draft['baselineOn'] = s.baseline.on ?? null; draft['baselineOdometer'] = s.baseline.odometer ?? null;
        }
        let f: ParsedTask;
        try { f = parseTask(draft, now, true); } catch (e) { throw e instanceof HttpProblem ? invalid(`${at}: ${e.message}`) : e; }
        if (count >= MAX_TASKS) throw invalid(`A vehicle allows at most ${MAX_TASKS} maintenance tasks.`);
        const id = await insertTask(c, v.id, f, p.userId);
        count++;
        if (s.baseline.kind === 'reported' && s.baseline.linkServiceItemId !== undefined) {
          const item = s.baseline.linkServiceItemId;
          if (linkedItems.has(item)) throw invalid(`${at}.baseline.linkServiceItemId is already linked to another task in this request.`);
          const n = (await c.query(`UPDATE service_items i SET task_id = $1 FROM service_visits sv
            WHERE i.id = $2 AND sv.id = i.visit_id AND sv.vehicle_id = $3 AND i.task_id IS NULL`, [id, item, v.id])).rowCount;
          if (!n) throw invalid(`${at}.baseline.linkServiceItemId must be a service item of this vehicle that is not linked to a task yet.`);
          linkedItems.add(item);
        }
        results.push({ presetTaskId: t.id, result: 'created', reason: null, taskId: id, created: true });
      }
      if (!preview) {
        await this.#audit(c, p, 'maintenance_preset.apply', v.id, {
          presetId: pr.id, presetVersion: pr.version, ...(variant ? { variant } : {}), results: results.map((r) => ({ presetTaskId: r.presetTaskId, result: r.result, taskId: r.taskId })),
        });
      }
      const e = await evaluateTasks(c, v.id, p.userId, now, { includeArchived: true });
      const byId = new Map(e.tasks.map((t) => [t.id, t]));
      return {
        presetId: pr.id, presetVersion: pr.version, variant, preview,
        reading: readingView(e),
        results: results.map((r) => {
          const t = byId.get(r.taskId)!;
          return {
            presetTaskId: r.presetTaskId, result: r.result, reason: r.reason, taskId: preview && r.created ? null : r.taskId, name: t.name,
            intervalMonths: t.intervalMonths, intervalDays: t.intervalDays, intervalDistance: t.intervalDistance, remindersEnabled: t.remindersEnabled, sourceTrust: t.sourceTrust,
            baselineKind: t.baselineKind, status: t.status, dueOn: t.dueOn, dueOdometer: t.dueOdometer, daysUntilDue: t.daysUntilDue, distanceUntilDue: t.distanceUntilDue,
            baseline: t.baseline, distanceBaselineMissing: t.distanceBaselineMissing, readingStale: t.readingStale, lastCompleted: t.lastCompleted,
          };
        }),
      };
    }, this.#manage, { rollback: preview });
  }
}

const readingView = (e: Evaluation) => (e.reading
  ? { odometer: asView(e.reading.km, e.odometerUnit), on: e.reading.on, source: e.reading.source, stale: daysBetween(e.reading.on, e.today) > STALE_READING_DAYS } : null);

export interface PresetList {
  market: string; vehicle: { make: string | null; model: string | null; year: number | null }; missing: ('make' | 'model' | 'year')[]; canApply: boolean;
  items: {
    id: string; version: number; market: string; make: string; model: string; year: number | null; yearRange: [number, number] | null; reviewedOn: string;
    sources: { title: string; url: string; kind: SourceTrust; note: string | null }[]; needsQualifier: string[];
    tasks: {
      id: string; name: string; catalogKey: string | null; description: string; rule: { months: number | null; distance: { value: string; unit: DistanceUnit } | null };
      trust: SourceTrust; sourceNote: string; severity: 'info' | 'caution' | null;
      alreadyImported: { taskId: Id; name: string; presetVersion: number; archived: boolean } | null;
      existingTaskMatch: { taskId: Id; name: string; matchedBy: 'catalogKey' | 'name' } | null;
      suggestedServiceItems: { id: Id; name: string; visitId: Id; servicedOn: string; odometer: Distance | null }[];
    }[];
  }[];
}
export interface PresetApplyResult {
  presetId: string; presetVersion: number; variant: string | null; preview: boolean; reading: ReturnType<typeof readingView>;
  results: Record<string, unknown>[];
}

async function existingTasks(q: Q, vehicleId: Id): Promise<(ExistingTask & { preset_version: number | null })[]> {
  return (await q.query<ExistingTask & { preset_version: number | null }>(
    'SELECT id, name, catalog_key, preset_id, preset_version, preset_task_id, archived_at IS NOT NULL AS archived FROM maintenance_tasks WHERE vehicle_id = $1 ORDER BY created_at, id', [vehicleId])).rows;
}

function parseMarket(v: unknown): string {
  if (v === undefined || v === null) return DEFAULT_MARKET;
  if (typeof v !== 'string' || !/^[a-z]{2,10}$/.test(v)) throw invalid('market must be a short lowercase market code such as us.');
  return v;
}

function parseVariant(pr: Preset, v: unknown): string | null {
  const variants = pr.variants ?? [];
  if (!variants.length) {
    if (v !== undefined && v !== null) throw invalid('This preset has no variants; leave variant out.');
    return null;
  }
  if (v === undefined || v === null) {
    throw new HttpProblem(422, 'maintenance_preset_variant_required', 'Validation failed', `This preset differs by variant; choose one of: ${variants.join(', ')}.`, { variants });
  }
  if (typeof v !== 'string' || !variants.includes(v)) throw invalid(`variant must be one of: ${variants.join(', ')}.`);
  return v;
}

interface Selection {
  presetTaskId: string;
  overrides: { intervalMonths?: unknown; intervalDistance?: unknown } | null;
  baseline: { kind: 'none' } | { kind: 'tracking' } | { kind: 'reported'; on?: unknown; odometer?: unknown; linkServiceItemId?: Id };
  onDuplicate: 'skip' | 'link';
}

/** The tasks the owner selected, shape only; values are validated by parseTask as the task is built. */
function parseSelection(pr: Preset, raw: unknown): Selection[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > pr.tasks.length) throw invalid('tasks must list 1 or more of the preset\'s tasks.');
  const seen = new Set<string>();
  return raw.map((r, i): Selection => {
    const at = `tasks[${i}]`;
    const s = obj(r, ['presetTaskId', 'overrides', 'baseline', 'onDuplicate'], at);
    const id = s['presetTaskId'];
    if (typeof id !== 'string' || !pr.tasks.some((t) => t.id === id)) throw invalid(`${at}.presetTaskId must be one of: ${pr.tasks.map((t) => t.id).join(', ')}.`);
    if (seen.has(id)) throw invalid(`${at}.presetTaskId ${id} is listed twice.`);
    seen.add(id);
    let overrides: Selection['overrides'] = null;
    if (s['overrides'] !== undefined && s['overrides'] !== null) overrides = obj(s['overrides'], ['intervalMonths', 'intervalDistance'], `${at}.overrides`);
    let baseline: Selection['baseline'] = { kind: 'none' };
    if (s['baseline'] !== undefined && s['baseline'] !== null) {
      const bl = obj(s['baseline'], ['kind', 'on', 'odometer', 'linkServiceItemId'], `${at}.baseline`);
      const kind = bl['kind'];
      if (kind === 'none' || kind === 'tracking') {
        if (Object.keys(bl).length > 1) throw invalid(`${at}.baseline of kind ${kind} takes no other fields.`);
        baseline = { kind };
      } else if (kind === 'reported') {
        const out: Extract<Selection['baseline'], { kind: 'reported' }> = { kind };
        if (bl['on'] !== undefined && bl['on'] !== null) out.on = bl['on'];
        if (bl['odometer'] !== undefined && bl['odometer'] !== null) out.odometer = bl['odometer'];
        if (bl['linkServiceItemId'] !== undefined && bl['linkServiceItemId'] !== null) {
          if (!isUuid(bl['linkServiceItemId'])) throw invalid(`${at}.baseline.linkServiceItemId must be a service item id.`);
          out.linkServiceItemId = bl['linkServiceItemId'] as Id;
        }
        if (out.on === undefined && out.odometer === undefined && out.linkServiceItemId === undefined) {
          throw invalid(`${at}.baseline of kind reported needs on, odometer or linkServiceItemId.`);
        }
        baseline = out;
      } else throw invalid(`${at}.baseline.kind must be 'reported', 'tracking' or 'none'.`);
    }
    const od = s['onDuplicate'] ?? 'skip';
    if (od !== 'skip' && od !== 'link') throw invalid(`${at}.onDuplicate must be 'skip' or 'link'.`);
    return { presetTaskId: id, overrides, baseline, onDuplicate: od };
  });
}

function parseScope(v: unknown): 'personal' | 'vehicle' {
  if (v === undefined || v === null) return 'personal';
  if (v !== 'personal' && v !== 'vehicle') throw invalid("scope must be 'personal' or 'vehicle'.");
  return v;
}
