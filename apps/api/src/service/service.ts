// Service history: visits (a date, optional odometer, provider or DIY, notes)
// with one or more items. Every method first requires the instance module
// (404 module_disabled) and then normal vehicle access (404 for non-members).
// Permissions: vehicles/permissions.ts (canWriteService, canChangeVisit).
// The odometer is optional, stored like fuel's (as entered plus kilometres) and
// never read from or written to fuel records. Costs: NULL is unknown, "0" is a
// known zero; they stay distinct end to end. Currency is the vehicle's.
// An item may name the maintenance task it completes (task_id): only ever by a
// person's choice, same vehicle only, and the link clears if the task is deleted.
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import { HttpProblem } from '../http/problem.ts';
import { bool, decimal, invalid, obj, uuid } from '../http/validate.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Principal } from '../identity.ts';
import { quantity } from '../fuel/service.ts';
import { requireModule } from '../modules.ts';
import type { Decimal, DistanceUnit, Id } from '../types.ts';
import { currencyScale, fromKm, isDistanceUnit, toKm } from '../units.ts';
import { dateOnly, text } from './fields.ts';
import { assertTaskLinks, taskRefs } from './maintenance.ts';
import { attachmentsFor, exportAttachments, type AttachmentView } from './attachments.ts';
import { canChangeVisit, canWriteService } from '../vehicles/permissions.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { VehicleAccess } from '../vehicles/types.ts';
import { auditAs } from '../audit.ts';
import { requireKeyGrant } from '../auth/api-key-auth.ts';

export const CATEGORIES = ['scheduled', 'repair', 'inspection', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const VISIT_FIELDS = ['servicedOn', 'odometer', 'provider', 'diy', 'totalCost', 'notes', 'items'] as const;
const ITEM_FIELDS = ['name', 'category', 'cost', 'notes', 'taskId'] as const;
export const MAX_ITEMS = 50;

interface VisitRow {
  id: Id; vehicle_id: Id; serviced_on: string; odometer_input: string | null; odometer_unit: DistanceUnit | null; odometer_km: string | null;
  provider: string | null; is_diy: boolean; visit_total_cost: string | null; currency: string; notes: string | null;
  created_by: Id | null; created_at: Date; updated_at: Date;
}
interface ItemRow { id: Id; visit_id: Id; position: number; name: string; category: Category; cost: string | null; notes: string | null; task_id: Id | null }
const COLS = `id, vehicle_id, serviced_on::text, odometer_input::text, odometer_unit, odometer_km::text, provider, is_diy, visit_total_cost::text, currency, notes, created_by, created_at, updated_at`;

export interface ParsedItem { name: string; category: Category; cost: string | null; notes: string | null; taskId: Id | null }
export interface ParsedVisit {
  servicedOn: string;
  odometer: { value: string; unit: DistanceUnit; km: Dec } | null;
  provider: string | null; diy: boolean; totalCost: string | null; notes: string | null; items: ParsedItem[];
}

/** `taskId` is the maintenance task this item completes (chosen by a person, never inferred); null when none or the task was deleted. */
export interface ServiceItemView { id: Id; name: string; category: Category; cost: Decimal | null; notes: string | null; taskId: Id | null }
export interface ServiceVisitView {
  id: Id; vehicleId: Id; servicedOn: string;
  /** Exactly as entered; null when not recorded. */
  odometer: { value: Decimal; unit: DistanceUnit } | null;
  /** Converted to the vehicle's odometer unit. */
  display: { odometer: { value: Decimal; unit: DistanceUnit } | null };
  provider: string | null; diy: boolean; totalCost: Decimal | null; currency: string; notes: string | null;
  items: ServiceItemView[]; attachments: AttachmentView[]; createdBy: Id | null; createdAt: string; updatedAt: string;
}

const notFound = () => new HttpProblem(404, 'service_visit_not_found', 'Service visit not found');
const forbidden = (detail = 'Your role does not allow changing service records.') => new HttpProblem(403, 'forbidden', 'Forbidden', detail);

function money(v: unknown, field: string, currency: string): string | null {
  if (v === undefined || v === null) return null;
  decimal(v, field, { maxScale: currencyScale(currency), max: '1000000000' });
  return v as string;
}

/** Validate a complete visit body against the vehicle's currency. */
export function parseVisit(body: Record<string, unknown>, currency: string, now: Date): ParsedVisit {
  const servicedOn = dateOnly(body['servicedOn'], 'servicedOn');
  if (new Date(`${servicedOn}T00:00:00Z`).getTime() > now.getTime() + 2 * 86_400_000) throw invalid('servicedOn is in the future.');
  if (Number(servicedOn.slice(0, 4)) < 1900) throw invalid('servicedOn is too far in the past.');
  let odometer: ParsedVisit['odometer'] = null;
  if (body['odometer'] !== undefined && body['odometer'] !== null) {
    const q = quantity(body['odometer'], 'odometer', isDistanceUnit, 'km, mi', { maxScale: 3, max: '9999999' });
    odometer = { value: q.value, unit: q.unit, km: toKm(q.dec, q.unit) };
  }
  const diy = body['diy'] === undefined ? false : bool(body['diy'], 'diy');
  if (!Array.isArray(body['items']) || body['items'].length < 1) throw invalid('A visit needs at least one item.');
  if (body['items'].length > MAX_ITEMS) throw invalid(`A visit allows at most ${MAX_ITEMS} items.`);
  const items = body['items'].map((raw, i): ParsedItem => {
    const it = obj(raw, ITEM_FIELDS, `items[${i}]`);
    const category = it['category'] === undefined || it['category'] === null ? 'other' : it['category'];
    if (!(CATEGORIES as readonly unknown[]).includes(category)) throw invalid(`items[${i}].category must be one of ${CATEGORIES.join(', ')}.`);
    return { name: text(it['name'], `items[${i}].name`, 120, true)!, category: category as Category, cost: money(it['cost'], `items[${i}].cost`, currency), notes: text(it['notes'], `items[${i}].notes`, 500),
      taskId: it['taskId'] === undefined || it['taskId'] === null ? null : uuid(it['taskId'], `items[${i}].taskId`) };
  });
  return {
    servicedOn, odometer, provider: text(body['provider'], 'provider', 120), diy, totalCost: money(body['totalCost'], 'totalCost', currency),
    notes: text(body['notes'], 'notes', 2000), items,
  };
}

interface PageRow extends VisitRow { created_at_text: string }
const like = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})\|([0-9T:. +-]{10,40})\|([0-9a-f-]{36})$/;
const encodeCursor = (r: PageRow) => Buffer.from(`${r.serviced_on}|${r.created_at_text}|${r.id}`).toString('base64url');

const canon = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * How many stored items a replacement list drops. Items have no ids in a request, so they are matched by their canonical name
 * (trimmed, whitespace-collapsed, case-insensitive), one for one: editing an item's cost, category, notes or task keeps it,
 * while removing or renaming one counts as removing it. A key needs `service.delete` when this is above zero (D1).
 */
export function droppedItemCount(stored: readonly { name: string }[], next: readonly { name: string }[]): number {
  const left = new Map<string, number>();
  for (const i of next) left.set(canon(i.name), (left.get(canon(i.name)) ?? 0) + 1);
  let dropped = 0;
  for (const e of stored) {
    const k = canon(e.name), n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1); else dropped++;
  }
  return dropped;
}

/** Linking an item to a maintenance task is choosing that task: a key needs maintenance.read (D1, spec "task selection"). */
function requireTaskLinkGrant(p: Principal, items: readonly { taskId: Id | null }[]): void {
  if (items.some((i) => i.taskId !== null)) requireKeyGrant(p, { module: 'maintenance', action: 'read' });
}

export interface ListOptions { limit?: number; cursor?: string; from?: string; to?: string; q?: string; category?: string }

export class ServiceService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #now: () => Date;
  constructor(pool: pg.Pool, vehicles: VehicleService, now: () => Date = () => new Date()) { this.#pool = pool; this.#vehicles = vehicles; this.#now = now; }

  async #items(q: Pick<pg.Pool, 'query'>, ids: Id[]): Promise<Map<Id, ItemRow[]>> {
    const out = new Map<Id, ItemRow[]>();
    if (!ids.length) return out;
    const { rows } = await q.query<ItemRow>('SELECT id, visit_id, position, name, category, cost::text, notes, task_id FROM service_items WHERE visit_id = ANY($1::uuid[]) ORDER BY visit_id, position', [ids]);
    for (const r of rows) (out.get(r.visit_id) ?? out.set(r.visit_id, []).get(r.visit_id)!).push(r);
    return out;
  }

  #view(r: VisitRow, items: ItemRow[], v: Pick<VehicleAccess, 'odometerUnit'>, attachments: AttachmentView[] = []): ServiceVisitView {
    return {
      id: r.id, vehicleId: r.vehicle_id, servicedOn: r.serviced_on,
      odometer: r.odometer_input === null ? null : { value: r.odometer_input as Decimal, unit: r.odometer_unit! },
      display: { odometer: r.odometer_km === null ? null : { value: fromKm(Dec.parse(r.odometer_km), v.odometerUnit).toFixed(0), unit: v.odometerUnit } },
      provider: r.provider, diy: r.is_diy, totalCost: r.visit_total_cost as Decimal | null, currency: r.currency, notes: r.notes,
      items: items.map((i) => ({ id: i.id, name: i.name, category: i.category, cost: i.cost as Decimal | null, notes: i.notes, taskId: i.task_id })), attachments,
      createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    };
  }

  async list(p: Principal, vehicleId: unknown, o: ListOptions = {}): Promise<{ items: ServiceVisitView[]; nextCursor: string | null }> {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const args: unknown[] = [v.id];
    const where = ['vehicle_id = $1'];
    const arg = (x: unknown) => { args.push(x); return `$${args.length}`; };
    if (o.from) where.push(`serviced_on >= ${arg(dateOnly(o.from, 'from'))}::date`);
    if (o.to) where.push(`serviced_on <= ${arg(dateOnly(o.to, 'to'))}::date`);
    if (o.from && o.to && o.from > o.to) throw invalid('from must not be after to.');
    if (o.category !== undefined) {
      if (!(CATEGORIES as readonly unknown[]).includes(o.category)) throw invalid(`category must be one of ${CATEGORIES.join(', ')}.`);
      where.push(`EXISTS (SELECT 1 FROM service_items i WHERE i.visit_id = service_visits.id AND i.category = ${arg(o.category)})`);
    }
    if (o.q?.trim()) {
      const t = arg(like(o.q.trim().slice(0, 100)));
      where.push(`(provider ILIKE ${t} OR notes ILIKE ${t} OR EXISTS (SELECT 1 FROM service_items i WHERE i.visit_id = service_visits.id AND (i.name ILIKE ${t} OR i.notes ILIKE ${t})))`);
    }
    if (o.cursor) {
      const m = CURSOR_RE.exec(Buffer.from(o.cursor, 'base64url').toString('utf8'));
      if (!m) throw invalid('cursor is not valid.');
      where.push(`(serviced_on, created_at, id) < (${arg(m[1])}::date, ${arg(m[2])}::timestamptz, ${arg(m[3])}::uuid)`);
    }
    const { rows } = await this.#pool.query<PageRow>(
      `SELECT ${COLS}, created_at::text AS created_at_text FROM service_visits WHERE ${where.join(' AND ')} ORDER BY serviced_on DESC, created_at DESC, id DESC LIMIT ${limit + 1}`, args);
    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);
    const [items, atts] = await Promise.all([this.#items(this.#pool, ids), attachmentsFor(this.#pool, ids)]);
    return { items: page.map((r) => this.#view(r, items.get(r.id) ?? [], v, atts.get(r.id) ?? [])), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
  }

  async get(p: Principal, vehicleId: unknown, visitId: unknown): Promise<ServiceVisitView> {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    return this.#one(this.#pool, v, visitId);
  }

  async #one(q: Pick<pg.Pool, 'query'>, v: VehicleAccess, visitId: unknown): Promise<ServiceVisitView> {
    if (!isUuid(visitId)) throw notFound();
    const r = (await q.query<VisitRow>(`SELECT ${COLS} FROM service_visits WHERE id = $1 AND vehicle_id = $2`, [visitId, v.id])).rows[0];
    if (!r) throw notFound();
    return this.#view(r, (await this.#items(q, [r.id])).get(r.id) ?? [], v, (await attachmentsFor(q, [r.id])).get(r.id) ?? []);
  }

  async #write<T>(p: Principal, vehicleId: unknown, fn: (c: pg.PoolClient, v: VehicleAccess) => Promise<T>): Promise<T> {
    await requireModule(this.#pool, 'service');
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      if (!canWriteService(v.role)) throw forbidden();
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived. Unarchive it to change its records.');
      const out = await fn(c, v);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async #audit(c: pg.PoolClient, p: Principal, action: string, vehicleId: Id, visitId: Id): Promise<void> {
    await auditAs(c, p, { action, subjectType: 'vehicle', subjectId: vehicleId, details: { visitId }, target: { type: 'service_visit', ids: [visitId] } });
  }

  async #insertItems(c: pg.PoolClient, visitId: Id, items: ParsedItem[]): Promise<void> {
    for (const [i, it] of items.entries()) {
      await c.query('INSERT INTO service_items (id, visit_id, position, name, category, cost, notes, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [uuidv7(), visitId, i, it.name, it.category, it.cost, it.notes, it.taskId]);
    }
  }

  /** Insert without authorization or audit; used by create and by import inside their own transaction. */
  async insertParsed(c: pg.PoolClient, vehicleId: Id, currency: string, f: ParsedVisit, createdBy: Id): Promise<Id> {
    const id = uuidv7();
    await c.query(
      `INSERT INTO service_visits (id, vehicle_id, serviced_on, odometer_input, odometer_unit, odometer_km, provider, is_diy, visit_total_cost, currency, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, vehicleId, f.servicedOn, f.odometer?.value ?? null, f.odometer?.unit ?? null, f.odometer?.km.toFixed(6) ?? null, f.provider, f.diy, f.totalCost, currency, f.notes, createdBy]);
    await this.#insertItems(c, id, f.items);
    return id;
  }

  /** Whether an identical visit (date, odometer, provider, ordered item names) is already stored; used by import. */
  async exists(c: pg.PoolClient, vehicleId: Id, f: ParsedVisit): Promise<boolean> {
    const { rows } = await c.query<{ names: string[] }>(
      `SELECT array_agg(i.name ORDER BY i.position) AS names FROM service_visits s JOIN service_items i ON i.visit_id = s.id
        WHERE s.vehicle_id = $1 AND s.serviced_on = $2 AND s.odometer_km IS NOT DISTINCT FROM $3::numeric AND s.provider IS NOT DISTINCT FROM $4 GROUP BY s.id`,
      [vehicleId, f.servicedOn, f.odometer?.km.toFixed(6) ?? null, f.provider]);
    const want = JSON.stringify(f.items.map((i) => i.name));
    return rows.some((r) => JSON.stringify(r.names) === want);
  }

  async create(p: Principal, vehicleId: unknown, body: unknown): Promise<ServiceVisitView> {
    const b = obj(body, VISIT_FIELDS);
    return this.#write(p, vehicleId, async (c, v) => {
      const f = parseVisit(b, v.currency, this.#now());
      requireTaskLinkGrant(p, f.items);
      await assertTaskLinks(c, v.id, f.items);
      const id = await this.insertParsed(c, v.id, v.currency, f, p.userId);
      await this.#audit(c, p, 'service_visit.create', v.id, id);
      return this.#one(c, v, id);
    });
  }

  /** Partial update: the stored visit is merged with the patch (items replace the whole list) and validated again. */
  async update(p: Principal, vehicleId: unknown, visitId: unknown, body: unknown): Promise<ServiceVisitView> {
    const patch = obj(body, VISIT_FIELDS);
    if (!Object.keys(patch).length) throw invalid('At least one field is required.');
    return this.#write(p, vehicleId, async (c, v) => {
      if (!isUuid(visitId)) throw notFound();
      const cur = (await c.query<VisitRow>(`SELECT ${COLS} FROM service_visits WHERE id = $1 AND vehicle_id = $2`, [visitId, v.id])).rows[0];
      if (!cur) throw notFound();
      if (!canChangeVisit(v.role, cur.created_by, p.userId)) throw forbidden('Drivers can change only the service visits they recorded.');
      const view = this.#view(cur, (await this.#items(c, [cur.id])).get(cur.id) ?? [], v);
      const merged = {
        servicedOn: view.servicedOn, odometer: view.odometer, provider: view.provider, diy: view.diy, totalCost: view.totalCost, notes: view.notes,
        items: view.items.map((i) => ({ name: i.name, category: i.category, cost: i.cost, notes: i.notes, taskId: i.taskId })), ...patch,
      };
      // The vehicle's currency cannot change once costs exist, so it is always the one these costs were entered in.
      const f = parseVisit(merged, v.currency, this.#now());
      if ('items' in patch) {
        requireTaskLinkGrant(p, f.items);
        // The stored items are deleted and re-created: a key that removes or renames one needs delete, not just update.
        if (droppedItemCount(view.items, f.items) > 0) requireKeyGrant(p, { module: 'service', action: 'delete' });
        await assertTaskLinks(c, v.id, f.items);
      }
      await c.query(
        `UPDATE service_visits SET serviced_on = $2, odometer_input = $3, odometer_unit = $4, odometer_km = $5, provider = $6, is_diy = $7, visit_total_cost = $8, notes = $9, currency = $10, updated_at = now() WHERE id = $1`,
        [cur.id, f.servicedOn, f.odometer?.value ?? null, f.odometer?.unit ?? null, f.odometer?.km.toFixed(6) ?? null, f.provider, f.diy, f.totalCost, f.notes, v.currency]);
      if ('items' in patch) {
        await c.query('DELETE FROM service_items WHERE visit_id = $1', [cur.id]);
        await this.#insertItems(c, cur.id, f.items);
      }
      await this.#audit(c, p, 'service_visit.update', v.id, cur.id);
      return this.#one(c, v, cur.id);
    });
  }

  async remove(p: Principal, vehicleId: unknown, visitId: unknown): Promise<void> {
    await this.#write(p, vehicleId, async (c, v) => {
      if (!isUuid(visitId)) throw notFound();
      const cur = await c.query<{ created_by: Id | null }>('SELECT created_by FROM service_visits WHERE id = $1 AND vehicle_id = $2', [visitId, v.id]);
      if (!cur.rows[0]) throw notFound();
      if (!canChangeVisit(v.role, cur.rows[0].created_by, p.userId)) throw forbidden('Drivers can delete only the service visits they recorded.');
      await c.query('DELETE FROM service_visits WHERE id = $1', [visitId]);
      await this.#audit(c, p, 'service_visit.delete', v.id, visitId);
    });
  }

  /**
   * Visits as import-shaped bodies, oldest first, for export. No module check
   * and no authorization here: data stays exportable while the module is off,
   * and the caller has already established membership.
   */
  async exportBodies(q: Pick<pg.Pool, 'query'>, vehicleId: Id): Promise<Record<string, unknown>[]> {
    const { rows } = await q.query<VisitRow>(`SELECT ${COLS} FROM service_visits WHERE vehicle_id = $1 ORDER BY serviced_on, created_at, id`, [vehicleId]);
    const ids = rows.map((r) => r.id);
    const [items, atts, refs] = await Promise.all([this.#items(q, ids), exportAttachments(q, ids), taskRefs(q, vehicleId)]);
    return rows.map((r) => ({
      servicedOn: r.serviced_on,
      odometer: r.odometer_input === null ? null : { value: r.odometer_input, unit: r.odometer_unit },
      provider: r.provider, diy: r.is_diy, totalCost: r.visit_total_cost, notes: r.notes,
      // `taskRef` points at an entry of the export's `maintenanceTasks` (ids never leave the instance).
      items: (items.get(r.id) ?? []).map((i) => ({ name: i.name, category: i.category, cost: i.cost, notes: i.notes, ...(i.task_id && refs.get(i.task_id) ? { taskRef: refs.get(i.task_id) } : {}) })),
      // Base64 bytes: exports with receipts can be large (see openapi).
      attachments: atts.get(r.id) ?? [],
    }));
  }
}
