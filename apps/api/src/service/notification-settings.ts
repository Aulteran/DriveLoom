// "Reminders by email" settings for one vehicle (Service module). Every route
// first requires the instance module (404 module_disabled), then membership
// (404 otherwise). Any member reads the settings and their own state; owner and
// editor (canManageNotifications) change the switch, the follow-up cadence and
// who receives emails, and also see the recipient list and a delivery summary.
// Any member may opt out of (or back into) their own emails; an opt-out always
// wins over a selection. Writes on an archived vehicle are 409. Changes are audited.
// SMTP itself is the administrator's: only whether it is configured is exposed.
import type pg from 'pg';
import type { HttpRequest, Route } from '../http/app.ts';
import { HttpProblem } from '../http/problem.ts';
import { bool, invalid, obj } from '../http/validate.ts';
import { isUuid } from '../ids.ts';
import { requirePrincipal, type Principal } from '../identity.ts';
import { requireModule } from '../modules.ts';
import { getPreferences } from '../preferences.ts';
import type { Decimal, DistanceUnit, Id } from '../types.ts';
import { canManageNotifications, canReceiveServiceEmail } from '../vehicles/permissions.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { Role, VehicleAccess } from '../vehicles/types.ts';
import { DEFAULT_FOLLOW_UP_DAYS, EMAIL_LEAD_DAYS, EMAIL_LEAD_DISTANCE, MAX_FOLLOW_UP_DAYS, deliverySummary } from './notifications.ts';
import { auditAs } from '../audit.ts';
import { apiKeyProblems } from '../auth/api-key-auth.ts';

type Q = Pick<pg.Pool, 'query'>;
const MAX_RECIPIENTS = 100;

export interface RecipientView { userId: Id; displayName: string; email: string; role: Role; selected: boolean; optedOut: boolean; implicit: boolean }
export interface NotificationSettingsView {
  emailEnabled: boolean; followUpDays: number;
  leadDays: number; leadDistance: { value: Decimal; unit: DistanceUnit };
  smtpConfigured: boolean; canManage: boolean;
  me: { eligible: boolean; selected: boolean; optedOut: boolean; receiving: boolean };
  /** For an API key: only the key owner's own entry (the other members' names and addresses are never sent to a key). */
  recipients: RecipientView[] | null;
  /** Present only for an API key: how many other recipients exist (not who). */
  otherRecipientCount?: number;
  delivery: { lastSentAt: string | null; pending: number; failed: number } | null;
}

const forbidden = () => new HttpProblem(403, 'forbidden', 'Forbidden', 'Only the owner or a manager can change reminder emails for this vehicle.');
const archived = () => new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived. Unarchive it to change its records.');

export class NotificationSettingsService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #smtp: () => boolean;
  constructor(pool: pg.Pool, vehicles: VehicleService, smtpConfigured: () => boolean) { this.#pool = pool; this.#vehicles = vehicles; this.#smtp = smtpConfigured; }

  async get(p: Principal, vehicleId: unknown): Promise<NotificationSettingsView> {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    return this.#view(this.#pool, v, p);
  }

  async #view(q: Q, v: VehicleAccess, p: Principal): Promise<NotificationSettingsView> {
    const [s, members, prefs] = await Promise.all([
      q.query<{ email_enabled: boolean; follow_up_days: number }>('SELECT email_enabled, follow_up_days FROM vehicle_notification_settings WHERE vehicle_id = $1', [v.id]),
      q.query<{ user_id: Id; role: Role; display_name: string; email: string; selected: boolean; opted_out: boolean }>(
        `SELECT m.user_id, m.role, u.display_name, u.email, COALESCE(r.enabled, false) AS selected, o.user_id IS NOT NULL AS opted_out
           FROM vehicle_members m JOIN users u ON u.id = m.user_id
           LEFT JOIN vehicle_notification_recipients r ON r.vehicle_id = m.vehicle_id AND r.user_id = m.user_id
           LEFT JOIN vehicle_notification_optouts o ON o.vehicle_id = m.vehicle_id AND o.user_id = m.user_id
          WHERE m.vehicle_id = $1 AND u.status = 'active' ORDER BY (m.role = 'owner') DESC, m.created_at, m.user_id`, [v.id]),
      getPreferences(q, p.userId),
    ]);
    const emailEnabled = s.rows[0]?.email_enabled ?? false;
    const followUpDays = s.rows[0]?.follow_up_days ?? DEFAULT_FOLLOW_UP_DAYS;
    const recipients: RecipientView[] = members.rows.filter((m) => canReceiveServiceEmail(m.role)).map((m) => ({
      userId: m.user_id, displayName: m.display_name, email: m.email, role: m.role,
      selected: m.role === 'owner' || m.selected, optedOut: m.opted_out, implicit: m.role === 'owner',
    }));
    const self = members.rows.find((m) => m.user_id === p.userId);
    const eligible = canReceiveServiceEmail(v.role);
    const selected = v.role === 'owner' || (eligible && !!self?.selected);
    const optedOut = !!self?.opted_out;
    const manage = canManageNotifications(v.role);
    return {
      emailEnabled, followUpDays, leadDays: EMAIL_LEAD_DAYS, leadDistance: { value: String(EMAIL_LEAD_DISTANCE) as Decimal, unit: prefs.distanceUnit },
      smtpConfigured: this.#smtp(), canManage: manage,
      me: { eligible, selected, optedOut, receiving: emailEnabled && eligible && selected && !optedOut },
      recipients: manage ? (p.kind === 'api_key' ? recipients.filter((r) => r.userId === p.userId) : recipients) : null,
      ...(manage && p.kind === 'api_key' ? { otherRecipientCount: recipients.filter((r) => r.userId !== p.userId).length } : {}),
      delivery: manage ? await deliverySummary(q, v.id) : null,
    };
  }

  async #write(p: Principal, vehicleId: unknown, fn: (c: pg.PoolClient, v: VehicleAccess) => Promise<void>, manage: boolean): Promise<NotificationSettingsView> {
    await requireModule(this.#pool, 'service');
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      if (manage && !canManageNotifications(v.role)) throw forbidden();
      if (v.archived) throw archived();
      await fn(c, v);
      const out = await this.#view(c, v, p);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async #audit(c: pg.PoolClient, p: Principal, action: string, vehicleId: Id, details: Record<string, unknown>): Promise<void> {
    await auditAs(c, p, { action, subjectType: 'vehicle', subjectId: vehicleId, details });
  }

  /** Partial update by the owner or a manager. `recipientUserIds` replaces the selection (the owner is always included). */
  async update(p: Principal, vehicleId: unknown, body: unknown): Promise<NotificationSettingsView> {
    const b = obj(body, ['emailEnabled', 'followUpDays', 'recipientUserIds']);
    if (!Object.keys(b).length) throw invalid('At least one field is required.');
    const emailEnabled = b['emailEnabled'] === undefined ? undefined : bool(b['emailEnabled'], 'emailEnabled');
    let followUpDays: number | undefined;
    if (b['followUpDays'] !== undefined) {
      const n = b['followUpDays'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_FOLLOW_UP_DAYS) throw invalid(`followUpDays must be a whole number of days from 0 (no follow-ups) to ${MAX_FOLLOW_UP_DAYS}.`);
      followUpDays = n;
    }
    let ids: Id[] | undefined;
    // Choosing recipients means naming other members; a key cannot see them (D2), so it may not set them either.
    if (b['recipientUserIds'] !== undefined && p.kind === 'api_key') throw apiKeyProblems.notAllowed('Reminder recipients are chosen in the web app, not with an API key.');
    if (b['recipientUserIds'] !== undefined) {
      const raw = b['recipientUserIds'];
      if (!Array.isArray(raw) || raw.length > MAX_RECIPIENTS || !raw.every(isUuid)) throw invalid(`recipientUserIds must be a list of at most ${MAX_RECIPIENTS} user ids.`);
      ids = [...new Set(raw as Id[])];
    }
    return this.#write(p, vehicleId, async (c, v) => {
      await c.query(
        `INSERT INTO vehicle_notification_settings (vehicle_id, email_enabled, follow_up_days, updated_by, updated_at) VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::integer, $5::integer), $4, now())
         ON CONFLICT (vehicle_id) DO UPDATE SET email_enabled = COALESCE($2::boolean, vehicle_notification_settings.email_enabled),
           follow_up_days = COALESCE($3::integer, vehicle_notification_settings.follow_up_days), updated_by = $4, updated_at = now()`,
        [v.id, emailEnabled ?? null, followUpDays ?? null, p.userId, DEFAULT_FOLLOW_UP_DAYS]);
      if (ids) {
        const { rows } = await c.query<{ user_id: Id; role: Role }>(
          "SELECT m.user_id, m.role FROM vehicle_members m JOIN users u ON u.id = m.user_id WHERE m.vehicle_id = $1 AND u.status = 'active' AND m.user_id = ANY($2::uuid[])", [v.id, ids]);
        const roleOf = new Map(rows.map((r) => [r.user_id, r.role]));
        const bad = ids.find((id) => !roleOf.has(id) || !canReceiveServiceEmail(roleOf.get(id)!));
        if (bad) throw invalid(`recipientUserIds: ${bad} is not a member who can receive reminder emails (the owner, a manager or a driver).`);
        const chosen = ids.filter((id) => roleOf.get(id) !== 'owner'); // the owner receives them without a row
        await c.query('DELETE FROM vehicle_notification_recipients WHERE vehicle_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [v.id, chosen]);
        for (const id of chosen) {
          await c.query(
            `INSERT INTO vehicle_notification_recipients (vehicle_id, user_id, enabled, selected_by) VALUES ($1,$2,true,$3)
             ON CONFLICT (vehicle_id, user_id) DO UPDATE SET enabled = true`, [v.id, id, p.userId]);
        }
      }
      await this.#audit(c, p, 'notification_settings.update', v.id, {
        ...(emailEnabled === undefined ? {} : { emailEnabled }), ...(followUpDays === undefined ? {} : { followUpDays }), ...(ids ? { recipients: ids.length } : {}),
      });
    }, true);
  }

  /** The caller's own choice. Any member; opting out always wins over being selected. */
  async setMine(p: Principal, vehicleId: unknown, body: unknown): Promise<NotificationSettingsView> {
    const b = obj(body, ['emailMe']);
    const emailMe = bool(b['emailMe'], 'emailMe');
    return this.#write(p, vehicleId, async (c, v) => {
      if (emailMe) await c.query('DELETE FROM vehicle_notification_optouts WHERE vehicle_id = $1 AND user_id = $2', [v.id, p.userId]);
      else await c.query('INSERT INTO vehicle_notification_optouts (vehicle_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [v.id, p.userId]);
      if (!emailMe) await c.query("UPDATE notification_outbox SET status = 'cancelled', last_error = 'opted_out' WHERE vehicle_id = $1 AND user_id = $2 AND status = 'pending'", [v.id, p.userId]);
      await this.#audit(c, p, 'notification_preference.update', v.id, { emailMe });
    }, false);
  }
}

export function notificationRoutes(svc: NotificationSettingsService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const base = '/v1/vehicles/:vehicleId/notification-settings';
  return [
    { method: 'GET', path: base, async handler(r) { return { status: 200, body: await svc.get(who(r), r.params['vehicleId']) }; } },
    { method: 'PUT', path: base, async handler(r) { return { status: 200, body: await svc.update(who(r), r.params['vehicleId'], r.body) }; } },
    { method: 'PUT', path: '/v1/vehicles/:vehicleId/notification-preferences/me', async handler(r) { return { status: 200, body: await svc.setMine(who(r), r.params['vehicleId'], r.body) }; } },
  ];
}
