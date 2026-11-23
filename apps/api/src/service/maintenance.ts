// Maintenance planning: per-vehicle tasks (from a name-only catalog or typed in),
// status against the latest known odometer, and snoozes. Rules live in
// maintenance-status.ts (pure); this file is storage, permissions and views.
// Every method first requires the instance module (404 module_disabled), then
// normal vehicle access (404 for non-members). Owner and editor manage tasks and
// vehicle-wide snoozes (canManageSchedules); every member, viewers included,
// may snooze for themselves only, which is personal reminder state.
// Snoozes never change a task's due point or status. Personal snoozes are never
// exported; vehicle-wide ones are. No email or push here: see tasksNeedingAttention
// for the helper a notifier reuses.
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
import { canManageSchedules } from '../vehicles/permissions.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { VehicleAccess } from '../vehicles/types.ts';
import { dateOnly, text } from './fields.ts';
import {
  CATALOG, LEAD_DAYS, LEAD_DISTANCE, STALE_READING_DAYS, catalogName, computeStatus, daysBetween, effectiveSnoozes, needsAttention, snoozeActive, utcDate,
  type Completion, type TaskState,
} from './maintenance-status.ts';
import { latestKnownOdometer, type KnownOdometer } from './odometer.ts';

type Q = Pick<pg.Pool, 'query'>;
export const TASK_FIELDS = ['name', 'catalogKey', 'recurring', 'intervalDays', 'intervalDistance', 'firstDueOn', 'firstDueOdometer', 'notes'] as const;
const PATCH_FIELDS = [...TASK_FIELDS, 'archived'] as const;
const SNOOZE_FIELDS = ['until', 'untilOdometer', 'additionalDistance', 'reason'] as const;
export const MAX_TASKS = 200;
const MAX_SNOOZE_DAYS = 3650;

interface TaskRow {
  id: Id; vehicle_id: Id; name: string; catalog_key: string | null; recurring: boolean; interval_days: number | null;
  interval_distance_input: string | null; interval_distance_unit: DistanceUnit | null; interval_distance_km: string | null;
  first_due_on: string | null; first_due_odometer_input: string | null; first_due_odometer_unit: DistanceUnit | null; first_due_odometer_km: string | null;
  notes: string | null; archived_at: Date | null; created_by: Id | null; created_at: Date; updated_at: Date;
}
const COLS = `id, vehicle_id, name, catalog_key, recurring, interval_days, interval_distance_input::text, interval_distance_unit, interval_distance_km::text,
  first_due_on::text, first_due_odometer_input::text, first_due_odometer_unit, first_due_odometer_km::text, notes, archived_at, created_by, created_at, updated_at`;
interface SnoozeDbRow { task_id: Id; scope: 'personal' | 'vehicle'; user_id: Id | null; until_date: string | null; until_km: string | null; reason: string | null; created_by: Id | null; created_at: Date }

interface Qty { value: string; unit: DistanceUnit; km: Dec }
export interface ParsedTask {
  name: string; catalogKey: string | null; recurring: boolean; intervalDays: number | null;
  intervalDistance: Qty | null; firstDueOn: string | null; firstDueOdometer: Qty | null; notes: string | null;
}
export interface Distance { value: Decimal; unit: DistanceUnit }
export interface SnoozeView { scope: 'personal' | 'vehicle'; until: string | null; untilOdometer: Distance | null; reason: string | null; createdBy: Id | null; createdAt: string }
export interface TaskView {
  id: Id; vehicleId: Id; name: string; catalogKey: string | null; recurring: boolean; intervalDays: number | null;
  intervalDistance: Distance | null; firstDueOn: string | null; firstDueOdometer: Distance | null; notes: string | null; archived: boolean;
  createdBy: Id | null; createdAt: string; updatedAt: string;
  /** Computed, never stored. See maintenance-status.ts for the rules. */
  status: TaskState; dueOn: string | null; dueOdometer: Distance | null; daysUntilDue: number | null; distanceUntilDue: Distance | null;
  baseline: 'completion' | 'first_due' | 'none'; distanceBaselineMissing: boolean; readingStale: boolean;
  lastCompleted: { visitId: Id; servicedOn: string; odometer: Distance | null } | null;
  /** The active snooze that applies to the caller (their personal one, else the vehicle-wide one); the original status stays visible. */
  snoozed: SnoozeView | null; snoozes: SnoozeView[]; reminderSuppressed: boolean; needsAttention: boolean;
}
export interface Evaluation { tasks: TaskView[]; reading: KnownOdometer | null; odometerUnit: DistanceUnit; distanceUnit: DistanceUnit; today: string }

const notFound = () => new HttpProblem(404, 'maintenance_task_not_found', 'Maintenance task not found');
const forbidden = (detail: string) => new HttpProblem(403, 'forbidden', 'Forbidden', detail);

/** Validate a complete task body. A recurring task repeats by an interval; a one-time task is due once, at a first-due date or odometer. */
export function parseTask(body: Record<string, unknown>, now: Date): ParsedTask {
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
  if (recurring && intervalDays === null && intervalDistance === null) throw invalid('A repeating task needs an interval in days, in distance, or both.');
  if (!recurring) {
    if (intervalDays !== null || intervalDistance !== null) throw invalid('A one-time task has no interval; set a due date or odometer instead.');
    if (firstDueOn === null && firstDueOdometer === null) throw invalid('A one-time task needs a due date or a due odometer.');
  }
  return { name, catalogKey: catalogKey as string | null, recurring, intervalDays, intervalDistance, firstDueOn, firstDueOdometer, notes: text(body['notes'], 'notes', 500) };
}

const dist = (input: string | null, unit: DistanceUnit | null): Distance | null => (input === null ? null : { value: input as Decimal, unit: unit! });
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
    recurring: r.recurring, intervalDays: r.interval_days, intervalDistanceKm: r.interval_distance_km === null ? null : Dec.parse(r.interval_distance_km),
    firstDueOn: r.first_due_on, firstDueOdometerKm: r.first_due_odometer_km === null ? null : Dec.parse(r.first_due_odometer_km),
  }, last, reading, today, distanceUnit);
  const rows = snoozeRows.map((s) => ({ scope: s.scope, untilDate: s.until_date, untilOdometerKm: s.until_km === null ? null : Dec.parse(s.until_km), src: s }));
  const snoozes: SnoozeView[] = effectiveSnoozes(rows, today, reading).map(({ scope, untilDate, untilOdometerKm, src }) => ({
    scope, until: untilDate, untilOdometer: untilOdometerKm === null ? null : asView(untilOdometerKm, odometerUnit), reason: src.reason, createdBy: src.created_by, createdAt: src.created_at.toISOString(),
  }));
  return {
    id: r.id, vehicleId: r.vehicle_id, name: r.name, catalogKey: r.catalog_key, recurring: r.recurring, intervalDays: r.interval_days,
    intervalDistance: dist(r.interval_distance_input, r.interval_distance_unit), firstDueOn: r.first_due_on, firstDueOdometer: dist(r.first_due_odometer_input, r.first_due_odometer_unit),
    notes: r.notes, archived: r.archived_at !== null, createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
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
 * For notifications: the vehicle's unarchived tasks that are due soon or
 * overdue, each with the person's effective snooze (`reminderSuppressed`). The
 * caller decides what to do with suppressed ones; they are included so a
 * digest can still list them as muted. Does not check the module switch or membership.
 */
export async function tasksNeedingAttention(q: Q, vehicleId: Id, userId: Id, now: Date = new Date()): Promise<TaskView[]> {
  return (await evaluateTasks(q, vehicleId, userId, now)).tasks.filter((t) => t.needsAttention);
}

// ---------- import / export (no module check: data stays portable while the module is off) ----------
export interface TaskExport {
  ref: string; name: string; catalogKey: string | null; recurring: boolean; intervalDays: number | null; intervalDistance: Distance | null;
  firstDueOn: string | null; firstDueOdometer: Distance | null; notes: string | null; archived: boolean;
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
      notes: r.notes, archived: r.archived_at !== null,
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
  return { ref: (ref as string | undefined) ?? null, f: parseTask(rest, now), archived: archived === true, snooze: sn };
}

export async function insertTask(c: Q, vehicleId: Id, f: ParsedTask, createdBy: Id, archived = false): Promise<Id> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO maintenance_tasks (id, vehicle_id, name, catalog_key, recurring, interval_days, interval_distance_input, interval_distance_unit, interval_distance_km,
       first_due_on, first_due_odometer_input, first_due_odometer_unit, first_due_odometer_km, notes, archived_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, vehicleId, f.name, f.catalogKey, f.recurring, f.intervalDays, f.intervalDistance?.value ?? null, f.intervalDistance?.unit ?? null, f.intervalDistance?.km.toFixed(6) ?? null,
      f.firstDueOn, f.firstDueOdometer?.value ?? null, f.firstDueOdometer?.unit ?? null, f.firstDueOdometer?.km.toFixed(6) ?? null, f.notes, archived ? new Date() : null, createdBy]);
  return id;
}

/** The id of an identical task already on the vehicle (same name, schedule and first-due point), used to skip duplicates on import. */
export async function findDuplicateTask(c: Q, vehicleId: Id, f: ParsedTask): Promise<Id | null> {
  const { rows } = await c.query<{ id: Id }>(
    `SELECT id FROM maintenance_tasks WHERE vehicle_id = $1 AND lower(name) = lower($2) AND catalog_key IS NOT DISTINCT FROM $3 AND recurring = $4
        AND interval_days IS NOT DISTINCT FROM $5 AND interval_distance_km IS NOT DISTINCT FROM $6::numeric
        AND first_due_on IS NOT DISTINCT FROM $7::date AND first_due_odometer_km IS NOT DISTINCT FROM $8::numeric ORDER BY created_at LIMIT 1`,
    [vehicleId, f.name, f.catalogKey, f.recurring, f.intervalDays, f.intervalDistance?.km.toFixed(6) ?? null, f.firstDueOn, f.firstDueOdometer?.km.toFixed(6) ?? null]);
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
  constructor(pool: pg.Pool, vehicles: VehicleService, now: () => Date = () => new Date()) { this.#pool = pool; this.#vehicles = vehicles; this.#now = now; }

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
      if (t.needsAttention) { counts.needsAttention++; if (!t.reminderSuppressed) counts.remindersActive++; }
    }
    return {
      counts,
      reading: e.reading ? { odometer: asView(e.reading.km, e.odometerUnit), on: e.reading.on, source: e.reading.source, stale: daysBetween(e.reading.on, e.today) > STALE_READING_DAYS } : null,
      defaults: { leadDays: LEAD_DAYS, leadDistance: { value: String(LEAD_DISTANCE) as Decimal, unit: e.distanceUnit }, staleReadingDays: STALE_READING_DAYS },
    };
  }

  async #write<T>(p: Principal, vehicleId: unknown, fn: (c: pg.PoolClient, v: VehicleAccess) => Promise<T>, allow: (role: VehicleAccess['role']) => string | null): Promise<T> {
    await requireModule(this.#pool, 'service');
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      const denied = allow(v.role);
      if (denied) throw forbidden(denied);
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived. Unarchive it to change its records.');
      const out = await fn(c, v);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async #audit(c: pg.PoolClient, p: Principal, action: string, vehicleId: Id, details: Record<string, unknown>): Promise<void> {
    await c.query("INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,$3,'vehicle',$4,$5)", [uuidv7(), p.userId, action, vehicleId, JSON.stringify(details)]);
  }
  readonly #manage = (role: VehicleAccess['role']) => (canManageSchedules(role) ? null : 'Your role does not allow changing maintenance tasks.');

  async create(p: Principal, vehicleId: unknown, body: unknown): Promise<TaskView> {
    const b = obj(body, TASK_FIELDS);
    return this.#write(p, vehicleId, async (c, v) => {
      const f = parseTask(b, this.#now());
      const n = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM maintenance_tasks WHERE vehicle_id = $1', [v.id])).rows[0]!.n);
      if (n >= MAX_TASKS) throw invalid(`A vehicle allows at most ${MAX_TASKS} maintenance tasks.`);
      const id = await insertTask(c, v.id, f, p.userId);
      await this.#audit(c, p, 'maintenance_task.create', v.id, { taskId: id });
      return this.#one(c, v, p, id);
    }, this.#manage);
  }

  /** Partial update: the stored task is merged with the patch and validated again as a whole. `archived` hides a task without deleting it. */
  async update(p: Principal, vehicleId: unknown, taskId: unknown, body: unknown): Promise<TaskView> {
    const patch = obj(body, PATCH_FIELDS);
    if (!Object.keys(patch).length) throw invalid('At least one field is required.');
    if ('archived' in patch) bool(patch['archived'], 'archived');
    return this.#write(p, vehicleId, async (c, v) => {
      const cur = await this.#one(c, v, p, taskId);
      const { archived, ...fields } = patch;
      const merged = {
        name: cur.name, catalogKey: cur.catalogKey, recurring: cur.recurring, intervalDays: cur.intervalDays, intervalDistance: cur.intervalDistance,
        firstDueOn: cur.firstDueOn, firstDueOdometer: cur.firstDueOdometer, notes: cur.notes, ...fields,
      };
      const f = parseTask(merged, this.#now());
      await c.query(
        `UPDATE maintenance_tasks SET name = $2, catalog_key = $3, recurring = $4, interval_days = $5, interval_distance_input = $6, interval_distance_unit = $7, interval_distance_km = $8,
           first_due_on = $9, first_due_odometer_input = $10, first_due_odometer_unit = $11, first_due_odometer_km = $12, notes = $13,
           archived_at = CASE WHEN $14::boolean IS NULL THEN archived_at WHEN $14 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1`,
        [cur.id, f.name, f.catalogKey, f.recurring, f.intervalDays, f.intervalDistance?.value ?? null, f.intervalDistance?.unit ?? null, f.intervalDistance?.km.toFixed(6) ?? null,
          f.firstDueOn, f.firstDueOdometer?.value ?? null, f.firstDueOdometer?.unit ?? null, f.firstDueOdometer?.km.toFixed(6) ?? null, f.notes, archived === undefined ? null : archived]);
      await this.#audit(c, p, 'maintenance_task.update', v.id, { taskId: cur.id });
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
}

function parseScope(v: unknown): 'personal' | 'vehicle' {
  if (v === undefined || v === null) return 'personal';
  if (v !== 'personal' && v !== 'vehicle') throw invalid("scope must be 'personal' or 'vehicle'.");
  return v;
}
