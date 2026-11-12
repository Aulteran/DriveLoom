// Vehicle, membership and ownership rules (milestone 1.3). Every method takes
// the authenticated Principal and authorizes server-side. A vehicle the caller
// has no grant on is reported as 404, and instance admins get no routine access:
// the only admin path is recoverOwnership, which is audited.
import type pg from 'pg';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import type { Principal } from '../identity.ts';
import { ApiError, conflict, forbidden, invalid, notFound } from './errors.ts';
import type { GrantableRole, Member, Role, Vehicle, VehicleInput, VehiclePatch } from './types.ts';

type Q = pg.PoolClient;
interface VehicleRow {
  id: Id; name: string; make: string | null; model: string | null; model_year: number | null;
  archived_at: Date | null; created_at: Date; updated_at: Date; role: Role;
}
const toVehicle = (r: VehicleRow): Vehicle => ({
  id: r.id, name: r.name, make: r.make, model: r.model, year: r.model_year, archived: r.archived_at !== null,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), role: r.role,
});
const COLS = 'v.id, v.name, v.make, v.model, v.model_year, v.archived_at, v.created_at, v.updated_at, m.role';

function text(v: unknown, field: string, required: boolean): string | null {
  if (v === undefined || v === null) { if (required) throw invalid(`${field} is required.`); return null; }
  if (typeof v !== 'string') throw invalid(`${field} must be a string.`);
  const t = v.trim();
  if (t.length < 1 || t.length > 80) throw invalid(`${field} must be 1 to 80 characters.`);
  return t;
}
function year(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1886 || v > new Date().getUTCFullYear() + 2) throw invalid('year is out of range.');
  return v;
}
function id(v: unknown): Id {
  if (!isUuid(v)) throw notFound();
  return v;
}

export class VehicleService {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) { this.#pool = pool; }

  async #tx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally { c.release(); }
  }

  async #audit(c: Q, actor: Id, action: string, vehicleId: Id, details: Record<string, unknown> = {}) {
    await c.query(
      "INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,$3,'vehicle',$4,$5)",
      [uuidv7(), actor, action, vehicleId, JSON.stringify(details)]);
  }

  /** Lock the vehicle row (serialises all mutations on it) and return the caller's role, or 404. */
  async #lock(c: Q, p: Principal, vehicleId: unknown): Promise<{ id: Id; role: Role }> {
    const vid = id(vehicleId);
    const { rows } = await c.query<{ role: Role | null }>(
      'SELECT (SELECT role FROM vehicle_members WHERE vehicle_id = v.id AND user_id = $2) AS role FROM vehicles v WHERE v.id = $1 FOR UPDATE',
      [vid, p.userId]);
    if (!rows[0] || !rows[0].role) throw notFound();
    return { id: vid, role: rows[0].role };
  }

  async #load(c: Q, p: Principal, vid: Id): Promise<Vehicle> {
    const { rows } = await c.query<VehicleRow>(
      `SELECT ${COLS} FROM vehicles v JOIN vehicle_members m ON m.vehicle_id = v.id AND m.user_id = $2 WHERE v.id = $1`, [vid, p.userId]);
    return toVehicle(rows[0]!);
  }

  async create(p: Principal, input: VehicleInput): Promise<Vehicle> {
    const name = text(input.name, 'name', true), make = text(input.make, 'make', false), model = text(input.model, 'model', false);
    const y = year(input.year);
    return this.#tx(async (c) => {
      const vid = uuidv7();
      await c.query('INSERT INTO vehicles (id, name, make, model, model_year) VALUES ($1,$2,$3,$4,$5)', [vid, name, make, model, y]);
      await c.query("INSERT INTO vehicle_members (vehicle_id, user_id, role, granted_by) VALUES ($1,$2,'owner',$2)", [vid, p.userId]);
      await this.#audit(c, p.userId, 'vehicle.create', vid);
      return this.#load(c, p, vid);
    });
  }

  async list(p: Principal, opts: { includeArchived?: boolean } = {}): Promise<Vehicle[]> {
    const { rows } = await this.#pool.query<VehicleRow>(
      `SELECT ${COLS} FROM vehicles v JOIN vehicle_members m ON m.vehicle_id = v.id AND m.user_id = $1
       WHERE ($2 OR v.archived_at IS NULL) ORDER BY v.id`, [p.userId, opts.includeArchived === true]);
    return rows.map(toVehicle);
  }

  async get(p: Principal, vehicleId: unknown): Promise<Vehicle> {
    const vid = id(vehicleId);
    const { rows } = await this.#pool.query<VehicleRow>(
      `SELECT ${COLS} FROM vehicles v JOIN vehicle_members m ON m.vehicle_id = v.id AND m.user_id = $2 WHERE v.id = $1`, [vid, p.userId]);
    if (!rows[0]) throw notFound();
    return toVehicle(rows[0]);
  }

  async update(p: Principal, vehicleId: unknown, patch: VehiclePatch): Promise<Vehicle> {
    const sets: string[] = [], vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 1}`); };
    if ('name' in patch) add('name', text(patch.name, 'name', true));
    if ('make' in patch) add('make', text(patch.make, 'make', false));
    if ('model' in patch) add('model', text(patch.model, 'model', false));
    if ('year' in patch) add('model_year', year(patch.year));
    return this.#tx(async (c) => {
      const v = await this.#lock(c, p, vehicleId);
      if (v.role === 'viewer') throw forbidden('editing this vehicle');
      if (sets.length) {
        await c.query(`UPDATE vehicles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [v.id, ...vals]);
        await this.#audit(c, p.userId, 'vehicle.update', v.id, { fields: Object.keys(patch) });
      }
      return this.#load(c, p, v.id);
    });
  }

  async setArchived(p: Principal, vehicleId: unknown, archived: boolean): Promise<Vehicle> {
    return this.#tx(async (c) => {
      const v = await this.#lock(c, p, vehicleId);
      if (v.role !== 'owner') throw forbidden('archiving this vehicle');
      await c.query('UPDATE vehicles SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1', [v.id, archived]);
      await this.#audit(c, p.userId, archived ? 'vehicle.archive' : 'vehicle.unarchive', v.id);
      return this.#load(c, p, v.id);
    });
  }

  async listMembers(p: Principal, vehicleId: unknown): Promise<Member[]> {
    const vid = id(vehicleId);
    await this.get(p, vid);
    const { rows } = await this.#pool.query(
      `SELECT m.user_id, m.role, m.granted_by, m.created_at, u.display_name, u.email
         FROM vehicle_members m JOIN users u ON u.id = m.user_id WHERE m.vehicle_id = $1 ORDER BY m.created_at, m.user_id`, [vid]);
    return rows.map((r) => ({ userId: r.user_id, role: r.role, grantedBy: r.granted_by, createdAt: r.created_at.toISOString(), displayName: r.display_name, email: r.email }));
  }

  #grantable(role: unknown): GrantableRole {
    if (role !== 'editor' && role !== 'viewer') throw invalid("role must be 'editor' or 'viewer'.");
    return role;
  }

  /** The new member is named by `userId` or, for people who only know each other's address, by `email`. */
  async addMember(p: Principal, vehicleId: unknown, userId: unknown, role: unknown, email?: unknown): Promise<Member> {
    const who = { userId, email };
    const r = this.#grantable(role);
    const byEmail = who.userId === undefined && typeof who.email === 'string';
    if (!byEmail && !isUuid(who.userId)) throw invalid('userId must be a user id (or pass email).');
    return this.#tx(async (c) => {
      const v = await this.#lock(c, p, vehicleId);
      if (v.role !== 'owner') throw forbidden('managing members');
      const u = await c.query<{ id: Id; display_name: string; email: string }>(
        `SELECT id, display_name, email FROM users WHERE status = 'active' AND ${byEmail ? 'email = lower(btrim($1))' : 'id = $1'}`, [byEmail ? who.email : who.userId]);
      if (!u.rows[0]) throw invalid('No active user matches.');
      const uid = u.rows[0].id;
      const ins = await c.query(
        'INSERT INTO vehicle_members (vehicle_id, user_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING created_at',
        [v.id, uid, r, p.userId]);
      if (!ins.rowCount) throw conflict('already_member', 'User is already a member of this vehicle.');
      await this.#audit(c, p.userId, 'member.add', v.id, { userId: uid, role: r });
      return { userId: uid, role: r, grantedBy: p.userId, createdAt: ins.rows[0].created_at.toISOString(), displayName: u.rows[0].display_name, email: u.rows[0].email };
    });
  }

  async changeMemberRole(p: Principal, vehicleId: unknown, userId: unknown, role: unknown): Promise<Member> {
    const r = this.#grantable(role);
    const uid = id(userId);
    return this.#tx(async (c) => {
      const v = await this.#lock(c, p, vehicleId);
      if (v.role !== 'owner') throw forbidden('managing members');
      const cur = await c.query<{ role: Role }>('SELECT role FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [v.id, uid]);
      if (!cur.rows[0]) throw invalid('That user is not a member.');
      if (cur.rows[0].role === 'owner') throw conflict('owner_immutable', 'The owner role changes only through ownership transfer.');
      const up = await c.query('UPDATE vehicle_members m SET role = $3 FROM users u WHERE m.vehicle_id = $1 AND m.user_id = $2 AND u.id = m.user_id RETURNING m.granted_by, m.created_at, u.display_name, u.email', [v.id, uid, r]);
      await this.#audit(c, p.userId, 'member.role_change', v.id, { userId: uid, from: cur.rows[0].role, to: r });
      return { userId: uid, role: r, grantedBy: up.rows[0].granted_by, createdAt: up.rows[0].created_at.toISOString(), displayName: up.rows[0].display_name, email: up.rows[0].email };
    });
  }

  /** The owner removes anyone else; any non-owner member may remove themselves (leave). */
  async removeMember(p: Principal, vehicleId: unknown, userId: unknown): Promise<void> {
    const uid = id(userId);
    await this.#tx(async (c) => {
      const v = await this.#lock(c, p, vehicleId);
      const self = uid === p.userId;
      if (v.role !== 'owner' && !self) throw forbidden('removing other members');
      const cur = await c.query<{ role: Role }>('SELECT role FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [v.id, uid]);
      if (!cur.rows[0]) throw invalid('That user is not a member.');
      if (cur.rows[0].role === 'owner') throw conflict('owner_required', 'A vehicle must keep an owner. Transfer ownership first.');
      await c.query('DELETE FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [v.id, uid]);
      await this.#audit(c, p.userId, self ? 'member.leave' : 'member.remove', v.id, { userId: uid, role: cur.rows[0].role });
    });
  }

  /** Owner hands ownership to an existing member; the previous owner becomes an editor. */
  async transferOwnership(p: Principal, vehicleId: unknown, toUserId: unknown): Promise<Vehicle> {
    const to = id(toUserId);
    return this.#tx(async (c) => {
      const v = await this.#lock(c, p, vehicleId);
      if (v.role !== 'owner') throw forbidden('transferring ownership');
      if (to === p.userId) throw conflict('already_owner', 'You already own this vehicle.');
      const t = await c.query("SELECT 1 FROM vehicle_members m JOIN users u ON u.id = m.user_id WHERE m.vehicle_id = $1 AND m.user_id = $2 AND u.status = 'active'", [v.id, to]);
      if (!t.rowCount) throw invalid('The new owner must be an active member of the vehicle.');
      await this.#swapOwner(c, v.id, p.userId, to);
      await this.#audit(c, p.userId, 'owner.transfer', v.id, { from: p.userId, to });
      return this.#load(c, p, v.id);
    });
  }

  async #swapOwner(c: Q, vid: Id, from: Id, to: Id) {
    // Demote first so the one-owner unique index is never violated.
    await c.query("UPDATE vehicle_members SET role = 'editor' WHERE vehicle_id = $1 AND user_id = $2 AND role = 'owner'", [vid, from]);
    await c.query(
      `INSERT INTO vehicle_members (vehicle_id, user_id, role, granted_by) VALUES ($1,$2,'owner',$3)
       ON CONFLICT (vehicle_id, user_id) DO UPDATE SET role = 'owner'`, [vid, to, from]);
  }

  /**
   * Admin recovery for a vehicle whose owner cannot act (for example a lost or
   * deleted account). The only vehicle operation open to instance admins: it
   * grants no read access to the vehicle's data and always writes an audit row
   * with a reason. The previous owner is kept as an editor unless disabled or
   * deleted, in which case the grant is removed.
   */
  async recoverOwnership(p: Principal, vehicleId: unknown, newOwnerId: unknown, reason: unknown): Promise<void> {
    if (p.instanceRole !== 'admin') throw notFound(); // do not reveal the operation to non-admins
    const vid = id(vehicleId), to = id(newOwnerId);
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) throw invalid('reason must be 3 to 500 characters.');
    await this.#tx(async (c) => {
      const lock = await c.query('SELECT 1 FROM vehicles WHERE id = $1 FOR UPDATE', [vid]);
      if (!lock.rowCount) throw notFound();
      const u = await c.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [to]);
      if (!u.rowCount) throw invalid('The new owner must be an active user.');
      const cur = await c.query<{ user_id: Id; status: string }>(
        "SELECT m.user_id, u.status FROM vehicle_members m JOIN users u ON u.id = m.user_id WHERE m.vehicle_id = $1 AND m.role = 'owner'", [vid]);
      const prev = cur.rows[0];
      if (prev?.user_id === to) throw conflict('already_owner', 'That user already owns this vehicle.');
      if (prev) await this.#swapOwner(c, vid, prev.user_id, to);
      else await c.query("INSERT INTO vehicle_members (vehicle_id, user_id, role, granted_by) VALUES ($1,$2,'owner',$3) ON CONFLICT (vehicle_id, user_id) DO UPDATE SET role = 'owner'", [vid, to, p.userId]);
      if (prev && prev.status !== 'active') await c.query('DELETE FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [vid, prev.user_id]);
      await this.#audit(c, p.userId, 'owner.recover', vid, { from: prev?.user_id ?? null, to, reason: reason.trim() });
    });
  }

  /**
   * Admin-only: ids of the vehicles a user owns, so an admin can see what
   * blocks an account removal and target recoverOwnership. Ids and archive
   * state only: no names, members or fuel data.
   */
  async listOwnedVehicleIds(p: Principal, userId: unknown): Promise<{ id: Id; archived: boolean }[]> {
    if (p.instanceRole !== 'admin') throw new ApiError(404, 'not_found', 'Not found');
    if (!isUuid(userId)) throw new ApiError(404, 'user_not_found', 'User not found');
    const u = await this.#pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!u.rowCount) throw new ApiError(404, 'user_not_found', 'User not found');
    const { rows } = await this.#pool.query<{ id: Id; archived: boolean }>(
      `SELECT v.id, v.archived_at IS NOT NULL AS archived FROM vehicle_members m JOIN vehicles v ON v.id = m.vehicle_id
        WHERE m.user_id = $1 AND m.role = 'owner' ORDER BY v.id`, [userId]);
    await this.#pool.query(
      "INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,'admin.list_owned_vehicles','user',$3,$4)",
      [uuidv7(), p.userId, userId, JSON.stringify({ count: rows.length })]);
    return rows;
  }
}
