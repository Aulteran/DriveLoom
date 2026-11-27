// Email reminders for maintenance that is due soon or overdue (Service module).
//
// Sent only through the administrator's SMTP settings; without them nothing is
// sent, rows wait in the outbox, and the in-app status keeps working as before.
//
// Who: for each vehicle whose owner or a manager turned emails on, the owner by
// default plus the managers and drivers they selected (never viewers). A
// person's own opt-out always wins. Membership, role, account status and
// opt-out are checked when a reminder is queued and again just before it is sent,
// so revoked or opted-out people get nothing.
//
// What and when: every unarchived task with reminders enabled (a per-task switch;
// imported preset tasks start with it off) that is due_soon or overdue for that
// person and not snoozed for them (personal or vehicle-wide snooze). Turning a
// task's reminders on records its current due state as already announced
// (seedReminderLedger in maintenance.ts), so opting in never sends a backlog. A task's
// due point (date and odometer) is its occurrence; each level (due soon,
// overdue) of an occurrence is announced once, then repeated every
// `follow_up_days` while it stays due (0 = no repeats). notification_task_log
// remembers what each person was told, so re-evaluating (every tick, every
// fill-up) never sends the same thing twice. A task that was hidden by a snooze
// is announced again once the snooze ends. Completing a task moves its due
// point (new occurrence) or makes it ok/completed, and queued reminders that
// only covered it are cancelled. Batching window: one evaluation run; all the
// tasks that need a reminder for one person and vehicle go in one email.
//
// Delivery: at least once. The evaluator holds a Postgres advisory lock per tick
// (so several app instances never run it twice at once) and a per-vehicle
// transaction lock; enqueueing is idempotent anyway (dedupe_key, ON CONFLICT
// DO NOTHING). The sender claims rows with FOR UPDATE SKIP LOCKED and a lease;
// a sender that dies after SMTP accepted a message but before recording it
// leaves the row to be claimed again when the lease ends, so that one message
// can arrive twice. Failures retry with exponential backoff, then end `failed`.
// Errors are stored without credentials.
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type pg from 'pg';
import type { Mailer } from '../auth/mailer.ts';
import { uuidv7 } from '../ids.ts';
import { isModuleEnabled } from '../modules.ts';
import type { DistanceUnit, Id } from '../types.ts';
import { fromKm } from '../units.ts';
import { EMAIL_RECIPIENT_ROLES } from '../vehicles/permissions.ts';
import type { Role } from '../vehicles/types.ts';
import { tasksNeedingAttention, type TaskView } from './maintenance.ts';
import { LEAD_DAYS, LEAD_DISTANCE, occurrenceKey } from './maintenance-status.ts';
import { latestKnownOdometer } from './odometer.ts';

type Q = Pick<pg.Pool, 'query'>;

// ---------- decided defaults ----------
/** "Due soon" lead, shared with the in-app status (maintenance-status.ts). */
export const EMAIL_LEAD_DAYS = LEAD_DAYS;
export const EMAIL_LEAD_DISTANCE = LEAD_DISTANCE;
/** Repeat a reminder this often while a task stays due or overdue. Per vehicle 0 (never) to 90. */
export const DEFAULT_FOLLOW_UP_DAYS = 7;
export const MAX_FOLLOW_UP_DAYS = 90;
/** How often the server evaluates and sends (server.ts). */
export const SCHEDULER_INTERVAL_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 5;
/** First retry after 1 minute, then 2, 4, 8. */
export const RETRY_BASE_MS = 60_000;
export const LEASE_MS = 5 * 60_000;
const DISPATCH_BATCH = 50;
const DAY = 86_400_000;
/** pg_try_advisory_lock key for the evaluator tick ("DLNT"), and the class of the per-vehicle transaction lock. */
const TICK_LOCK = 0x444c4e54;
const VEHICLE_LOCK_CLASS = 0x444c4e56;

export type Level = 'due_soon' | 'overdue';
export interface PayloadTask {
  taskId: Id; name: string; status: Level; occurrence: string;
  dueOn: string | null; dueOdometer: { value: string; unit: DistanceUnit } | null;
}
/** What a queued row holds: task ids, names, status, due points and the reading. No notes, plates, VINs, receipts or costs. */
export interface Payload { tasks: PayloadTask[]; reading: { value: string; unit: DistanceUnit; on: string } | null }

export interface Recipient { userId: Id; email: string; role: Role }

/** The task's due point (shared with maintenance.ts, which seeds the ledger when reminders are turned on). */
export { occurrenceKey };

/** Follow-up period number since the first reminder; always 0 without follow-ups. */
export const followUpBucket = (firstAt: Date, now: Date, followUpDays: number): number =>
  followUpDays > 0 ? Math.max(0, Math.floor((now.getTime() - firstAt.getTime()) / (followUpDays * DAY))) : 0;

/** Delay before retry number `attempts` (1-based). */
export const retryDelayMs = (attempts: number): number => RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

/** An error as stored and logged: its code and a short message with any credentials in URLs removed. */
export function redactError(e: unknown): string {
  const err = e as { code?: unknown; responseCode?: unknown; message?: unknown };
  const code = typeof err?.code === 'string' ? err.code : typeof err?.responseCode === 'number' ? String(err.responseCode) : '';
  const msg = (typeof err?.message === 'string' ? err.message : String(e))
    .replace(/\/\/[^\s/@]*@/g, '//***@')
    .replace(/(pass(word)?|auth|user(name)?)=\S+/gi, '$1=***')
    .replace(/[\r\n\t]+/g, ' ');
  return `${code ? `${code}: ` : ''}${msg}`.slice(0, 300);
}

/**
 * Who would receive this vehicle's emails right now: active members whose role
 * may receive them, the owner unless opted out, others only when selected and
 * not opted out. Does not look at the switches; callers do.
 */
export async function recipientsOf(q: Q, vehicleId: Id): Promise<Recipient[]> {
  const { rows } = await q.query<{ user_id: Id; email: string; role: Role }>(
    `SELECT m.user_id, u.email, m.role FROM vehicle_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN vehicle_notification_recipients r ON r.vehicle_id = m.vehicle_id AND r.user_id = m.user_id
       LEFT JOIN vehicle_notification_optouts o ON o.vehicle_id = m.vehicle_id AND o.user_id = m.user_id
      WHERE m.vehicle_id = $1 AND u.status = 'active' AND o.user_id IS NULL AND m.role = ANY($2::text[])
        AND (m.role = 'owner' OR r.enabled IS TRUE)
      ORDER BY m.created_at, m.user_id`, [vehicleId, EMAIL_RECIPIENT_ROLES]);
  return rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }));
}

interface VehicleState { enabled: boolean; followUpDays: number; title: string; odometerUnit: DistanceUnit }

/** The vehicle as it may appear in an email: nickname, else year make model. Never the plate or VIN. */
export function emailVehicleTitle(v: { name: string | null; make: string | null; model: string | null; model_year: number | null }): string {
  return v.name || [v.model_year, v.make, v.model].filter((x) => x !== null && x !== '').join(' ') || 'your vehicle';
}

async function vehicleState(q: Q, vehicleId: Id): Promise<VehicleState | null> {
  const { rows } = await q.query<{ name: string | null; make: string | null; model: string | null; model_year: number | null; odometer_unit: DistanceUnit; archived: boolean; email_enabled: boolean | null; follow_up_days: number | null }>(
    `SELECT v.name, v.make, v.model, v.model_year, v.odometer_unit, v.archived_at IS NOT NULL AS archived, s.email_enabled, s.follow_up_days
       FROM vehicles v LEFT JOIN vehicle_notification_settings s ON s.vehicle_id = v.id WHERE v.id = $1`, [vehicleId]);
  const r = rows[0];
  if (!r) return null;
  return { enabled: !r.archived && r.email_enabled === true, followUpDays: r.follow_up_days ?? DEFAULT_FOLLOW_UP_DAYS, title: emailVehicleTitle(r), odometerUnit: r.odometer_unit };
}

const payloadTask = (t: TaskView): PayloadTask => ({
  taskId: t.id, name: t.name, status: t.status as Level, occurrence: occurrenceKey(t), dueOn: t.dueOn, dueOdometer: t.dueOdometer,
});

/** Tasks that still deserve this person's reminder: due now, not snoozed for them, same due point as queued. */
export async function stillDue(q: Q, vehicleId: Id, userId: Id, queued: PayloadTask[], now: Date): Promise<TaskView[]> {
  const want = new Map(queued.map((t) => [t.taskId, t.occurrence]));
  return (await tasksNeedingAttention(q, vehicleId, userId, now)).filter((t) => !t.reminderSuppressed && want.get(t.id) === occurrenceKey(t));
}

async function readingFor(q: Q, vehicleId: Id, unit: DistanceUnit): Promise<Payload['reading']> {
  const r = await latestKnownOdometer(q, vehicleId);
  return r ? { value: fromKm(r.km, unit).toFixed(0), unit, on: r.on } : null;
}

// ---------- email ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const group = (v: string) => v.replace(/^(-?\d+)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const LABEL: Record<Level, string> = { due_soon: 'due soon', overdue: 'overdue' };

export interface EmailContent { subject: string; text: string; html: string }

/** Plain text and simple HTML for one person and vehicle. Every interpolated value is escaped in the HTML. */
export function renderEmail(vehicleTitle: string, tasks: PayloadTask[], reading: Payload['reading'], link: string | null): EmailContent {
  const title = vehicleTitle.replace(/[\r\n]+/g, ' ');
  const n = tasks.length;
  const overdue = tasks.filter((t) => t.status === 'overdue').length;
  const subject = `Maintenance ${overdue ? 'overdue' : 'due soon'} for ${title} (${n} task${n === 1 ? '' : 's'})`.slice(0, 200);
  const due = (t: PayloadTask) => [t.dueOn ? `on ${t.dueOn}` : null, t.dueOdometer ? `at ${group(t.dueOdometer.value)} ${t.dueOdometer.unit}` : null].filter(Boolean).join(' or ');
  const readingLine = reading ? `Latest known odometer: ${group(reading.value)} ${reading.unit}, recorded on ${reading.on}.` : 'No odometer reading is known for this vehicle yet.';
  const safety = 'These reminders follow the intervals entered in DriveLoom. DriveLoom is not a substitute for your manufacturer\'s schedule or a mechanic\'s advice.';
  const footer = `You get this email because you are on the reminder list for ${title}. To stop these emails, open the vehicle's Service page, choose Maintenance and turn off "Email me about this vehicle". Snoozing a task only mutes its reminders; it does not reschedule or complete it.`;
  const text = [
    `Maintenance for ${title} needs attention:`, '',
    ...tasks.flatMap((t) => [`- ${t.name}: ${LABEL[t.status]}`, `  Due ${due(t) || 'now'}.`]), '',
    readingLine, '',
    ...(link ? [`Open the Service page: ${link}`, ''] : []),
    safety, '', '--', footer, '',
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:sans-serif;line-height:1.4">',
    `<p>Maintenance for <strong>${esc(title)}</strong> needs attention:</p>`,
    '<ul>', ...tasks.map((t) => `<li><strong>${esc(t.name)}</strong>: ${esc(LABEL[t.status])}<br>Due ${esc(due(t) || 'now')}.</li>`), '</ul>',
    `<p>${esc(readingLine)}</p>`,
    link ? `<p><a href="${esc(link)}">Open the Service page</a></p>` : '',
    `<p>${esc(safety)}</p>`,
    `<hr><p style="font-size:small;color:#555">${esc(footer)}</p>`,
    '</body></html>',
  ].join('\n');
  return { subject, text, html };
}

// ---------- the notifier ----------
export interface NotifierDeps {
  db: pg.Pool;
  /** Read on each dispatch: administrator SMTP changes take effect without a restart. */
  mailer: () => Mailer | null;
  /** The instance's public origin, for the link to the Service page; null omits the link. */
  publicOrigin: string | null;
  log?: (message: string) => void;
}
export interface EvaluationResult { skipped?: 'locked' | 'module_disabled'; vehicles: number; enqueued: number; cancelled: number }
export interface DispatchResult { skipped?: 'no_smtp'; sent: number; retried: number; failed: number; cancelled: number }

export class Notifier {
  readonly #d: NotifierDeps;
  readonly #id = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  #timer: NodeJS.Timeout | null = null;
  #first: NodeJS.Timeout | null = null;
  #running: Promise<unknown> | null = null;
  readonly #background = new Set<Promise<void>>();
  constructor(deps: NotifierDeps) { this.#d = deps; }

  #log(m: string) { (this.#d.log ?? ((x: string) => console.warn(x)))(m); }

  /** Link to the authenticated Service page (the web client's hash route). */
  link(vehicleId: Id): string | null {
    return this.#d.publicOrigin ? `${this.#d.publicOrigin}/#/vehicles/${vehicleId}/service?view=maintenance` : null;
  }

  /**
   * One evaluator tick over every vehicle. Skips (and does nothing) while another
   * instance holds the tick lock. With the module off, cancels every queued reminder.
   */
  async runEvaluation(now: Date = new Date()): Promise<EvaluationResult> {
    const out: EvaluationResult = { vehicles: 0, enqueued: 0, cancelled: 0 };
    const lockClient = await this.#d.db.connect();
    let locked = false;
    try {
      locked = (await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [TICK_LOCK])).rows[0]!.ok;
      if (!locked) return { ...out, skipped: 'locked' };
      if (!(await isModuleEnabled(this.#d.db, 'service'))) {
        out.cancelled = await cancel(this.#d.db, "status = 'pending'", [], 'module_disabled');
        return { ...out, skipped: 'module_disabled' };
      }
      const { rows } = await this.#d.db.query<{ vehicle_id: Id }>(
        `SELECT s.vehicle_id FROM vehicle_notification_settings s JOIN vehicles v ON v.id = s.vehicle_id
          WHERE s.email_enabled AND v.archived_at IS NULL ORDER BY s.vehicle_id`);
      const ids = rows.map((r) => r.vehicle_id);
      // Vehicles whose emails were turned off or archived lose what they had queued.
      out.cancelled += await cancel(this.#d.db, "status = 'pending' AND NOT (vehicle_id = ANY($1::uuid[]))", [ids], 'emails_off');
      for (const id of ids) {
        const r = await this.evaluateVehicle(id, now);
        out.vehicles++; out.enqueued += r.enqueued; out.cancelled += r.cancelled;
      }
      return out;
    } finally {
      if (locked) await lockClient.query('SELECT pg_advisory_unlock($1)', [TICK_LOCK]).catch(() => undefined);
      lockClient.release();
    }
  }

  /** Evaluate one vehicle: queue what is new for each recipient, cancel what is no longer due. */
  async evaluateVehicle(vehicleId: Id, now: Date = new Date()): Promise<{ enqueued: number; cancelled: number }> {
    const c = await this.#d.db.connect();
    let enqueued = 0, cancelled = 0;
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [VEHICLE_LOCK_CLASS, vehicleId]);
      const v = await vehicleState(c, vehicleId);
      if (!v || !v.enabled || !(await isModuleEnabled(c, 'service'))) {
        cancelled += await cancel(c, "status = 'pending' AND vehicle_id = $1", [vehicleId], 'emails_off');
        await c.query('COMMIT');
        return { enqueued, cancelled };
      }
      const recipients = await recipientsOf(c, vehicleId);
      cancelled += await cancel(c, "status = 'pending' AND vehicle_id = $1 AND NOT (user_id = ANY($2::uuid[]))", [vehicleId, recipients.map((r) => r.userId)], 'not_a_recipient');
      const reading = await readingFor(c, vehicleId, v.odometerUnit);
      for (const r of recipients) {
        const res = await this.#evaluateRecipient(c, vehicleId, v, r.userId, reading, now);
        enqueued += res.enqueued; cancelled += res.cancelled;
      }
      await c.query('COMMIT');
      return { enqueued, cancelled };
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async #evaluateRecipient(c: pg.PoolClient, vehicleId: Id, v: VehicleState, userId: Id, reading: Payload['reading'], now: Date): Promise<{ enqueued: number; cancelled: number }> {
    let cancelled = 0;
    const all = await tasksNeedingAttention(c, vehicleId, userId, now);
    const active = all.filter((t) => !t.reminderSuppressed);
    const activeKey = new Map(active.map((t) => [t.id, occurrenceKey(t)]));
    // Queued, unsent reminders: drop tasks that are done, snoozed or rescheduled; cancel rows left empty.
    const pending = (await c.query<{ id: Id; payload: Payload }>(
      "SELECT id, payload FROM notification_outbox WHERE vehicle_id = $1 AND user_id = $2 AND status = 'pending' ORDER BY created_at", [vehicleId, userId])).rows;
    const carried = new Map<Id, PayloadTask>();
    for (const p of pending) {
      const keep = p.payload.tasks.filter((t) => activeKey.get(t.taskId) === t.occurrence);
      if (!keep.length) { cancelled += await cancel(c, 'id = $1', [p.id], 'no_longer_due'); continue; }
      for (const t of keep) carried.set(t.taskId, t);
    }
    // Snoozed tasks that were announced before come back once the snooze ends.
    for (const t of all.filter((x) => x.reminderSuppressed)) {
      await c.query('UPDATE notification_task_log SET muted = true WHERE user_id = $1 AND task_id = $2 AND occurrence_key = $3 AND level = $4 AND NOT muted', [userId, t.id, occurrenceKey(t), t.status]);
    }
    const log = active.length ? (await c.query<{ task_id: Id; occurrence_key: string; level: Level; first_notified_at: Date; last_bucket: number; sends: number; muted: boolean }>(
      'SELECT task_id, occurrence_key, level, first_notified_at, last_bucket, sends, muted FROM notification_task_log WHERE user_id = $1 AND task_id = ANY($2::uuid[])',
      [userId, active.map((t) => t.id)])).rows : [];
    const fresh: { t: TaskView; key: string; bucket: number }[] = [];
    for (const t of active) {
      const occ = occurrenceKey(t);
      const row = log.find((l) => l.task_id === t.id && l.occurrence_key === occ && l.level === t.status);
      if (!row) { fresh.push({ t, key: `${t.id}:${occ}:${t.status}:0`, bucket: 0 }); continue; }
      const bucket = followUpBucket(row.first_notified_at, now, v.followUpDays);
      if (row.muted || bucket > row.last_bucket) fresh.push({ t, key: `${t.id}:${occ}:${t.status}:${row.sends}`, bucket });
    }
    if (!fresh.length) return { enqueued: 0, cancelled };
    // One email per person and vehicle: what is new now, plus what was still waiting to be sent.
    const tasks = new Map(carried);
    for (const f of fresh) tasks.set(f.t.id, payloadTask(f.t));
    const payload: Payload = { tasks: [...tasks.values()], reading };
    const dedupeKey = createHash('sha256').update(`${vehicleId}|${userId}|${fresh.map((f) => f.key).sort().join(',')}`).digest('hex');
    const ins = await c.query(
      `INSERT INTO notification_outbox (id, vehicle_id, user_id, dedupe_key, payload, status, attempts, next_attempt_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',0,$6,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [uuidv7(now.getTime()), vehicleId, userId, dedupeKey, JSON.stringify(payload), now]);
    if (!ins.rowCount) return { enqueued: 0, cancelled };
    const newId = ins.rows[0].id as Id;
    for (const p of pending) await c.query("UPDATE notification_outbox SET status = 'cancelled', last_error = 'superseded' WHERE id = $1 AND status = 'pending' AND id <> $2", [p.id, newId]);
    for (const f of fresh) {
      await c.query(
        `INSERT INTO notification_task_log (user_id, task_id, vehicle_id, occurrence_key, level, first_notified_at, last_bucket, sends, muted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,false)
         ON CONFLICT (user_id, task_id, occurrence_key, level) DO UPDATE SET last_bucket = GREATEST(notification_task_log.last_bucket, EXCLUDED.last_bucket), sends = notification_task_log.sends + 1, muted = false`,
        [userId, f.t.id, vehicleId, occurrenceKey(f.t), f.t.status, now, f.bucket]);
    }
    return { enqueued: 1, cancelled };
  }

  /**
   * Send what is due. Without SMTP nothing is claimed or counted as an attempt:
   * rows wait. Each row is checked again before sending (module, switch,
   * membership, opt-out, still due and not snoozed) and cancelled if it no longer applies.
   */
  async dispatchOutbox(now: Date = new Date()): Promise<DispatchResult> {
    const out: DispatchResult = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
    const mailer = this.#d.mailer();
    if (!mailer) return { ...out, skipped: 'no_smtp' };
    // One row per claim, each with its own lease and token, so a slow SMTP server
    // cannot let a lease run out on rows still waiting in this batch.
    for (let i = 0; i < DISPATCH_BATCH; i++) {
      const token = `${this.#id}:${randomBytes(4).toString('hex')}`;
      const { rows } = await this.#d.db.query<{ id: Id; vehicle_id: Id; user_id: Id; payload: Payload; attempts: number }>(
        `WITH c AS (
           SELECT id FROM notification_outbox
            WHERE (status = 'pending' AND next_attempt_at <= $1) OR (status = 'sending' AND lease_until <= $1)
            ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
         UPDATE notification_outbox o SET status = 'sending', claimed_at = $1, claimed_by = $2, lease_until = $3, attempts = o.attempts + 1
           FROM c WHERE o.id = c.id RETURNING o.id, o.vehicle_id, o.user_id, o.payload, o.attempts`,
        [now, token, new Date(now.getTime() + LEASE_MS)]);
      const row = rows[0];
      if (!row) break;
      await this.#deliver(mailer, row, token, now, out);
    }
    if (out.failed || out.retried) this.#log(`service reminders: ${out.retried} to retry, ${out.failed} failed`);
    return out;
  }

  async #deliver(mailer: Mailer, row: { id: Id; vehicle_id: Id; user_id: Id; payload: Payload; attempts: number }, token: string, now: Date, out: DispatchResult): Promise<void> {
    // Every final update is conditional on still holding this claim.
    const mine = 'id = $1 AND claimed_by = $2 AND status = \'sending\'';
    const moduleOn = await isModuleEnabled(this.#d.db, 'service');
    const v = moduleOn ? await vehicleState(this.#d.db, row.vehicle_id) : null;
    const who = v?.enabled ? (await recipientsOf(this.#d.db, row.vehicle_id)).find((r) => r.userId === row.user_id) : undefined;
    const tasks = who ? await stillDue(this.#d.db, row.vehicle_id, row.user_id, row.payload.tasks, now) : [];
    if (!v || !who || !tasks.length) {
      const reason = !moduleOn ? 'module_disabled' : !v?.enabled ? 'emails_off' : !who ? 'not_a_recipient' : 'no_longer_due';
      await this.#d.db.query(`UPDATE notification_outbox SET status = 'cancelled', last_error = $3, lease_until = NULL WHERE ${mine}`, [row.id, token, reason]);
      out.cancelled++;
      return;
    }
    const reading = await readingFor(this.#d.db, row.vehicle_id, v.odometerUnit);
    const mail = renderEmail(v.title, tasks.map(payloadTask), reading, this.link(row.vehicle_id));
    try {
      await mailer.send(who.email, mail.subject, mail.text, mail.html);
      await this.#d.db.query(`UPDATE notification_outbox SET status = 'sent', sent_at = $3, lease_until = NULL, last_error = NULL WHERE ${mine}`, [row.id, token, now]);
      out.sent++;
    } catch (e) {
      const err = redactError(e);
      if (row.attempts >= MAX_ATTEMPTS) {
        await this.#d.db.query(`UPDATE notification_outbox SET status = 'failed', last_error = $3, lease_until = NULL WHERE ${mine}`, [row.id, token, err]);
        out.failed++;
      } else {
        await this.#d.db.query(`UPDATE notification_outbox SET status = 'pending', last_error = $3, lease_until = NULL, next_attempt_at = $4 WHERE ${mine}`,
          [row.id, token, err, new Date(now.getTime() + retryDelayMs(row.attempts))]);
        out.retried++;
      }
    }
  }

  /** Evaluate then send. Never throws; errors are logged without details that could hold credentials. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.#running) return;
    const run = (async () => {
      try { await this.runEvaluation(now); await this.dispatchOutbox(now); } catch (e) { this.#log(`service reminders: run failed: ${redactError(e)}`); }
    })();
    this.#running = run;
    try { await run; } finally { this.#running = null; }
  }

  /**
   * After an odometer change (fill-up or visit). Fire and forget: the caller's
   * request never waits for or fails because of it.
   */
  afterOdometerChange(vehicleId: Id): void {
    const p = (async () => {
      try {
        const now = new Date();
        await this.evaluateVehicle(vehicleId, now);
        await this.dispatchOutbox(now);
      } catch (e) { this.#log(`service reminders: evaluation after an odometer change failed: ${redactError(e)}`); }
    })();
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  /** Resolves once every fire-and-forget evaluation started so far has finished (tests, shutdown). */
  async settled(): Promise<void> { await Promise.all([...this.#background]); }

  /** Periodic ticks (unref'd, so they never keep the process alive). */
  start(intervalMs: number = SCHEDULER_INTERVAL_MS, firstRunMs = 30_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref();
    this.#first = setTimeout(() => void this.tick(), firstRunMs);
    this.#first.unref();
  }
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    this.#timer = this.#first = null;
    await this.#running?.catch(() => undefined);
    await this.settled();
  }
}

async function cancel(q: Q, where: string, params: unknown[], reason: string): Promise<number> {
  const n = params.length;
  return (await q.query(`UPDATE notification_outbox SET status = 'cancelled', last_error = $${n + 1} WHERE ${where}`, [...params, reason])).rowCount ?? 0;
}

/** For the settings page: delivery counts without any recipient addresses or error text. */
export async function deliverySummary(q: Q, vehicleId: Id): Promise<{ lastSentAt: string | null; pending: number; failed: number }> {
  const { rows } = await q.query<{ last: Date | null; pending: number; failed: number }>(
    `SELECT max(sent_at) AS last, count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM notification_outbox WHERE vehicle_id = $1`, [vehicleId]);
  return { lastSentAt: rows[0]?.last?.toISOString() ?? null, pending: rows[0]?.pending ?? 0, failed: rows[0]?.failed ?? 0 };
}
