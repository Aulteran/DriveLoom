// Friends and aggregate comparison (milestone 1.5).
//
// Exposure rule: a viewer sees another user's vehicle only when (1) the two
// have an accepted friendship, (2) that user owns the vehicle and (3) the
// owner opted the vehicle in. All three are checked in the query that builds
// each response, so opting out or unfriending takes effect on the next request.
// What crosses is a name, the vehicle's description and one aggregate economy
// figure for a fixed window: no ids, records, dates, distances, volumes or
// counts, and cost only when the currencies match.
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import { HttpProblem } from '../http/problem.ts';
import { bool, invalid, obj } from '../http/validate.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Principal } from '../identity.ts';
import { getPreferences } from '../preferences.ts';
import type { Id } from '../types.ts';
import { currencyScale, distanceUnitOf, fromKm } from '../units.ts';
import type { FuelService } from '../fuel/service.ts';
import type { VehicleService } from '../vehicles/service.ts';

export const WINDOWS = { '30d': 30, '90d': 90, '365d': 365, all: null } as const;
export type WindowKey = keyof typeof WINDOWS;
const MAX_PENDING_OUT = 50;

const notFound = () => new HttpProblem(404, 'friendship_not_found', 'Friend request not found');

export class FriendService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #fuel: FuelService;
  readonly #now: () => Date;
  constructor(pool: pg.Pool, vehicles: VehicleService, fuel: FuelService, now: () => Date = () => new Date()) {
    this.#pool = pool; this.#vehicles = vehicles; this.#fuel = fuel; this.#now = now;
  }

  async #audit(q: Pick<pg.Pool, 'query'>, actor: Id, action: string, subjectType: 'user' | 'vehicle', subjectId: Id, details: Record<string, unknown> = {}) {
    await q.query('INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv7(), actor, action, subjectType, subjectId, JSON.stringify(details)]);
  }

  /** Ask another user of this instance, by email. If they already asked you, this accepts. */
  async request(p: Principal, body: unknown): Promise<{ status: 'pending' | 'accepted' }> {
    const { email } = obj(body, ['email']);
    if (typeof email !== 'string' || !email.trim()) throw invalid('email is required.');
    const u = (await this.#pool.query<{ id: Id }>("SELECT id FROM users WHERE email = lower(btrim($1)) AND status = 'active'", [email])).rows[0];
    if (!u) throw invalid('No active user matches.');
    if (u.id === p.userId) throw invalid('You cannot add yourself.');
    const out = await this.#pool.query("SELECT count(*)::int AS n FROM friendships WHERE requester_id = $1 AND status = 'pending'", [p.userId]);
    if (out.rows[0].n >= MAX_PENDING_OUT) throw new HttpProblem(429, 'too_many_requests', 'Too many pending friend requests');
    const ins = await this.#pool.query('INSERT INTO friendships (id, requester_id, addressee_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [uuidv7(), p.userId, u.id]);
    if (ins.rowCount) { await this.#audit(this.#pool, p.userId, 'friend.request', 'user', u.id); return { status: 'pending' }; }
    // A relationship already exists. If the other side asked first, asking back is acceptance.
    const acc = await this.#pool.query(
      "UPDATE friendships SET status = 'accepted', accepted_at = $3 WHERE requester_id = $2 AND addressee_id = $1 AND status = 'pending'", [p.userId, u.id, this.#now()]);
    if (acc.rowCount) { await this.#audit(this.#pool, p.userId, 'friend.accept', 'user', u.id); return { status: 'accepted' }; }
    const cur = await this.#pool.query<{ status: 'pending' | 'accepted' }>(
      'SELECT status FROM friendships WHERE LEAST(requester_id, addressee_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(requester_id, addressee_id) = GREATEST($1::uuid, $2::uuid)', [p.userId, u.id]);
    return { status: cur.rows[0]?.status ?? 'pending' };
  }

  async list(p: Principal) {
    const { rows } = await this.#pool.query<{ id: Id; status: string; mine: boolean; other_id: Id; display_name: string; email: string; created_at: Date; accepted_at: Date | null }>(
      `SELECT f.id, f.status, f.requester_id = $1 AS mine, u.id AS other_id, u.display_name, u.email, f.created_at, f.accepted_at
         FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND u.status = 'active' ORDER BY f.id`, [p.userId]);
    const person = (r: (typeof rows)[number]) => ({ id: r.id, userId: r.other_id, displayName: r.display_name, email: r.email });
    return {
      friends: rows.filter((r) => r.status === 'accepted').map((r) => ({ ...person(r), since: r.accepted_at!.toISOString() })),
      incoming: rows.filter((r) => r.status === 'pending' && !r.mine).map((r) => ({ ...person(r), requestedAt: r.created_at.toISOString() })),
      outgoing: rows.filter((r) => r.status === 'pending' && r.mine).map((r) => ({ ...person(r), requestedAt: r.created_at.toISOString() })),
    };
  }

  /** Only the person who was asked can accept. */
  async accept(p: Principal, friendshipId: unknown): Promise<void> {
    if (!isUuid(friendshipId)) throw notFound();
    const r = await this.#pool.query<{ requester_id: Id }>(
      "UPDATE friendships SET status = 'accepted', accepted_at = $3 WHERE id = $1 AND addressee_id = $2 AND status = 'pending' RETURNING requester_id", [friendshipId, p.userId, this.#now()]);
    if (!r.rows[0]) throw notFound();
    await this.#audit(this.#pool, p.userId, 'friend.accept', 'user', r.rows[0].requester_id);
  }

  /** Decline, cancel or unfriend: either side removes the relationship, and with it all comparison access. */
  async remove(p: Principal, friendshipId: unknown): Promise<void> {
    if (!isUuid(friendshipId)) throw notFound();
    const r = await this.#pool.query<{ requester_id: Id; addressee_id: Id }>(
      'DELETE FROM friendships WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2) RETURNING requester_id, addressee_id', [friendshipId, p.userId]);
    if (!r.rows[0]) throw notFound();
    await this.#audit(this.#pool, p.userId, 'friend.remove', 'user', r.rows[0].requester_id === p.userId ? r.rows[0].addressee_id : r.rows[0].requester_id);
  }

  async getOptIn(p: Principal, vehicleId: unknown): Promise<{ enabled: boolean }> {
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    const r = await this.#pool.query('SELECT 1 FROM vehicle_comparison_optins WHERE vehicle_id = $1', [v.id]);
    return { enabled: !!r.rowCount };
  }

  /** Per-vehicle, owner-only, explicit. Off by default. */
  async setOptIn(p: Principal, vehicleId: unknown, body: unknown): Promise<{ enabled: boolean }> {
    const enabled = bool(obj(body, ['enabled'])['enabled'], 'enabled');
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      if (v.role !== 'owner') throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Only the owner decides whether a vehicle is compared with friends.');
      const r = enabled
        ? await c.query('INSERT INTO vehicle_comparison_optins (vehicle_id, enabled_by) VALUES ($1,$2) ON CONFLICT DO NOTHING', [v.id, p.userId])
        : await c.query('DELETE FROM vehicle_comparison_optins WHERE vehicle_id = $1', [v.id]);
      if (r.rowCount) await this.#audit(c, p.userId, enabled ? 'comparison.opt_in' : 'comparison.opt_out', 'vehicle', v.id);
      await c.query('COMMIT');
      return { enabled };
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async compare(p: Principal, windowKey: string | null) {
    const key = (windowKey ?? '90d') as WindowKey;
    if (!Object.hasOwn(WINDOWS, key)) throw invalid(`window must be one of ${Object.keys(WINDOWS).join(', ')}.`);
    const to = this.#now();
    const days = WINDOWS[key];
    const w = { from: days === null ? null : new Date(to.getTime() - days * 86_400_000), to };
    const prefs = await getPreferences(this.#pool, p.userId);
    const per = distanceUnitOf(prefs.economyUnit);

    interface V { id: Id; name: string; make: string | null; model: string | null; model_year: number | null; currency: string }
    const describe = (v: V) => ({ name: v.name, make: v.make, model: v.model, year: v.model_year });
    const figures = async (v: V, scale: number) => {
      const s = await this.#fuel.summary(v.id, w, prefs);
      // Costs compare only in one currency: the viewer's. No conversion is attempted.
      const sameCurrency = v.currency === prefs.currency;
      const cost = sameCurrency && !s.costDistanceKm.isZero() ? s.cost.div(fromKm(s.costDistanceKm, per)) : null;
      return {
        economy: s.economy && { value: Dec.parse(s.economy.value).toFixed(scale), unit: s.economy.unit },
        costPerDistance: cost && { value: cost.toFixed(currencyScale(v.currency) + 2), currency: v.currency, per },
        costUnavailableReason: cost ? null : !sameCurrency ? 'currency_mismatch' as const : 'no_cost_data' as const,
      };
    };

    const mine = await this.#pool.query<V>(
      `SELECT v.id, v.name, v.make, v.model, v.model_year, v.currency FROM vehicles v JOIN vehicle_members m ON m.vehicle_id = v.id AND m.user_id = $1
        WHERE v.archived_at IS NULL ORDER BY v.id`, [p.userId]);
    // The grant: accepted friendship AND owner AND opt-in AND active account, evaluated now.
    const theirs = await this.#pool.query<V & { owner_id: Id; display_name: string }>(
      `SELECT v.id, v.name, v.make, v.model, v.model_year, v.currency, u.id AS owner_id, u.display_name
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AND u.status = 'active'
         JOIN vehicle_members m ON m.user_id = u.id AND m.role = 'owner'
         JOIN vehicles v ON v.id = m.vehicle_id AND v.archived_at IS NULL
         JOIN vehicle_comparison_optins o ON o.vehicle_id = v.id
        WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
        ORDER BY u.id, v.id`, [p.userId]);

    const friends = new Map<Id, { userId: Id; displayName: string; vehicles: unknown[] }>();
    for (const v of theirs.rows) {
      const f = friends.get(v.owner_id) ?? { userId: v.owner_id, displayName: v.display_name, vehicles: [] };
      // One decimal for friends: enough to compare, coarse enough not to fingerprint single purchases.
      f.vehicles.push({ ...describe(v), ...(await figures(v, 1)) });
      friends.set(v.owner_id, f);
    }
    return {
      window: { key, from: w.from?.toISOString() ?? null, to: to.toISOString() },
      units: { economy: prefs.economyUnit, distance: per, currency: prefs.currency },
      mine: await Promise.all(mine.rows.map(async (v) => ({ vehicleId: v.id, ...describe(v), ...(await figures(v, 2)) }))),
      friends: [...friends.values()],
    };
  }
}
