// Fuel purchases, odometer history and economy (milestone 1.4). Authorization
// goes through VehicleService.access: viewers read, editors and owners write.
// Nothing derived is stored: intervals are recomputed from the ordered records
// on every read, so a backdate, correction or deletion repairs its neighbours.
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import { HttpProblem } from '../http/problem.ts';
import { bool, decimal, instant, invalid, obj } from '../http/validate.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Principal } from '../identity.ts';
import { getPreferences, type Preferences } from '../preferences.ts';
import type { Decimal, DistanceUnit, Id, VolumeUnit } from '../types.ts';
import {
  DISPLAY_SCALE, currencyScale, distanceUnitOf, economy, fromKm, fromLitres, isCurrency, isDistanceUnit, isVolumeUnit, money, toKm, toLitres,
} from '../units.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { VehicleAccess } from '../vehicles/types.ts';
import { aggregate, intervals, inWindow, type Fill, type Interval, type Window } from './economy.ts';

export interface FillUpRow {
  id: Id; vehicle_id: Id; occurred_at: Date;
  odometer_input: string; odometer_unit: DistanceUnit; odometer_km: string;
  volume_input: string; volume_unit: VolumeUnit; volume_l: string;
  is_full: boolean; missed_previous: boolean;
  cost_amount: string | null; cost_currency: string | null; exchange_rate: string | null; reporting_amount: string | null;
  notes: string; created_by: Id | null; created_at: Date; updated_at: Date;
}
const COLS = `id, vehicle_id, occurred_at, odometer_input::text, odometer_unit, odometer_km::text, volume_input::text, volume_unit, volume_l::text,
  is_full, missed_previous, cost_amount::text, cost_currency, exchange_rate::text, reporting_amount::text, notes, created_by, created_at, updated_at`;
const ORDER = 'occurred_at, odometer_km, id';

const toFill = (r: FillUpRow): Fill => ({
  id: r.id, occurredAt: r.occurred_at, odometerKm: Dec.parse(r.odometer_km), volumeL: Dec.parse(r.volume_l),
  full: r.is_full, missedPrevious: r.missed_previous, reportingCost: r.reporting_amount === null ? null : Dec.parse(r.reporting_amount),
});

export interface Quantity<U> { value: Decimal; unit: U }
export interface FillUpView {
  id: Id; vehicleId: Id; occurredAt: string;
  /** Exactly as entered. */
  odometer: Quantity<DistanceUnit>; volume: Quantity<VolumeUnit>;
  full: boolean; missedPrevious: boolean;
  cost: { amount: Decimal; currency: string; exchangeRate: Decimal | null; reportingAmount: Decimal; reportingCurrency: string } | null;
  notes: string; createdBy: Id | null; createdAt: string; updatedAt: string;
  /** Converted for the viewer: odometer in the vehicle's odometer unit, volume in the viewer's volume unit. */
  display: { odometer: Quantity<DistanceUnit>; volume: Quantity<VolumeUnit> };
  /** Present on full fills: the full-to-full interval this purchase closes. */
  interval: IntervalView | null;
}
export interface IntervalView {
  available: boolean; reason: Interval['reason'];
  distance: Quantity<DistanceUnit> | null; volume: Quantity<VolumeUnit> | null; economy: Quantity<Preferences['economyUnit']> | null;
}

const notFound = () => new HttpProblem(404, 'fill_up_not_found', 'Fill-up not found');

export interface ParsedFillUp {
  occurredAt: Date; odometer: string; odometerUnit: DistanceUnit; odometerKm: Dec; volume: string; volumeUnit: VolumeUnit; volumeL: Dec;
  full: boolean; missedPrevious: boolean; notes: string;
  cost: { amount: string; currency: string; exchangeRate: string | null; reportingAmount: string } | null;
}

function quantity<U>(v: unknown, field: string, isUnit: (u: unknown) => u is U, units: string, o: { maxScale: number; max: string; positive?: boolean }): { value: string; unit: U; dec: Dec } {
  const q = obj(v, ['value', 'unit'], field);
  if (!isUnit(q['unit'])) throw invalid(`${field}.unit must be one of ${units}. Choose the unit explicitly.`);
  return { value: q['value'] as string, unit: q['unit'], dec: decimal(q['value'], `${field}.value`, o) };
}

export const FILL_UP_FIELDS = ['occurredAt', 'odometer', 'volume', 'full', 'missedPrevious', 'cost', 'notes'] as const;

/** Validate a complete fill-up body against the vehicle's reporting currency. */
export function parseFillUp(body: Record<string, unknown>, vehicleCurrency: string, now: Date): ParsedFillUp {
  const occurredAt = instant(body['occurredAt'], 'occurredAt');
  if (occurredAt.getTime() > now.getTime() + 86_400_000) throw invalid('occurredAt is in the future.');
  if (occurredAt.getUTCFullYear() < 1900) throw invalid('occurredAt is too far in the past.');
  const odo = quantity(body['odometer'], 'odometer', isDistanceUnit, 'km, mi', { maxScale: 3, max: '9999999' });
  const vol = quantity(body['volume'], 'volume', isVolumeUnit, 'l, gal_us, gal_imp', { maxScale: 3, max: '100000', positive: true });
  const full = body['full'] === undefined ? true : bool(body['full'], 'full');
  const missedPrevious = body['missedPrevious'] === undefined ? false : bool(body['missedPrevious'], 'missedPrevious');
  const notes = body['notes'] === undefined || body['notes'] === null ? '' : body['notes'];
  if (typeof notes !== 'string' || notes.length > 500) throw invalid('notes must be text of at most 500 characters.');
  let cost: ParsedFillUp['cost'] = null;
  if (body['cost'] !== undefined && body['cost'] !== null) {
    const c = obj(body['cost'], ['amount', 'currency', 'exchangeRate', 'reportingAmount', 'reportingCurrency'], 'cost');
    const amount = decimal(c['amount'], 'cost.amount', { maxScale: 4, max: '1000000000' });
    if (!isCurrency(c['currency'])) throw invalid('cost.currency must be an ISO 4217 code such as EUR.');
    const rate = c['exchangeRate'] === undefined || c['exchangeRate'] === null ? null : decimal(c['exchangeRate'], 'cost.exchangeRate', { maxScale: 10, max: '1000000000', positive: true });
    const given = c['reportingAmount'] === undefined || c['reportingAmount'] === null ? null : decimal(c['reportingAmount'], 'cost.reportingAmount', { maxScale: 4, max: '1000000000' });
    let reporting: string;
    if (c['currency'] === vehicleCurrency) {
      // Same currency: the reporting amount is the amount. A rate would be meaningless.
      if (rate) throw invalid('cost.exchangeRate applies only to a purchase in another currency.');
      if (given && given.cmp(amount) !== 0) throw invalid('cost.reportingAmount must equal cost.amount when the currencies match.');
      reporting = c['amount'] as string;
    } else if (given) {
      reporting = c['reportingAmount'] as string;
    } else if (rate) {
      reporting = amount.mul(rate).toFixed(currencyScale(vehicleCurrency));
    } else {
      throw new HttpProblem(422, 'reporting_amount_required', 'Validation failed',
        `This purchase is in ${c['currency']} but the vehicle reports in ${vehicleCurrency}. Send cost.exchangeRate or cost.reportingAmount; no rate is assumed.`);
    }
    cost = { amount: c['amount'] as string, currency: c['currency'], exchangeRate: rate ? (c['exchangeRate'] as string) : null, reportingAmount: reporting };
  }
  return {
    occurredAt, odometer: odo.value, odometerUnit: odo.unit, odometerKm: toKm(odo.dec, odo.unit), volume: vol.value, volumeUnit: vol.unit, volumeL: toLitres(vol.dec, vol.unit),
    full, missedPrevious, notes: notes.trim(), cost,
  };
}

/** The body a stored row would have been created from (for PATCH merging and export). */
export function rowToBody(r: FillUpRow): Record<string, unknown> {
  return {
    occurredAt: r.occurred_at.toISOString(),
    odometer: { value: r.odometer_input, unit: r.odometer_unit },
    volume: { value: r.volume_input, unit: r.volume_unit },
    full: r.is_full, missedPrevious: r.missed_previous, notes: r.notes,
    cost: r.cost_amount === null ? null : { amount: r.cost_amount, currency: r.cost_currency, exchangeRate: r.exchange_rate, reportingAmount: r.reporting_amount },
  };
}

function intervalView(i: Interval, prefs: Preferences): IntervalView {
  if (!i.available) return { available: false, reason: i.reason, distance: null, volume: null, economy: null };
  const e = economy(i.distanceKm, i.volumeL, prefs.economyUnit);
  return {
    available: true, reason: null,
    distance: { value: fromKm(i.distanceKm, prefs.distanceUnit).toFixed(DISPLAY_SCALE.distance), unit: prefs.distanceUnit },
    volume: { value: fromLitres(i.volumeL, prefs.volumeUnit).toFixed(DISPLAY_SCALE.volume), unit: prefs.volumeUnit },
    economy: e && { value: e.toFixed(DISPLAY_SCALE.economy), unit: prefs.economyUnit },
  };
}

function view(r: FillUpRow, v: VehicleAccess, prefs: Preferences, byEnd: Map<Id, Interval>): FillUpView {
  const i = byEnd.get(r.id);
  return {
    id: r.id, vehicleId: r.vehicle_id, occurredAt: r.occurred_at.toISOString(),
    odometer: { value: r.odometer_input as Decimal, unit: r.odometer_unit },
    volume: { value: r.volume_input as Decimal, unit: r.volume_unit },
    full: r.is_full, missedPrevious: r.missed_previous,
    cost: r.cost_amount === null ? null : {
      amount: r.cost_amount as Decimal, currency: r.cost_currency!, exchangeRate: r.exchange_rate as Decimal | null,
      reportingAmount: r.reporting_amount as Decimal, reportingCurrency: v.currency,
    },
    notes: r.notes, createdBy: r.created_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    display: {
      odometer: { value: fromKm(Dec.parse(r.odometer_km), v.odometerUnit).toFixed(0), unit: v.odometerUnit },
      volume: { value: fromLitres(Dec.parse(r.volume_l), prefs.volumeUnit).toFixed(DISPLAY_SCALE.volume), unit: prefs.volumeUnit },
    },
    interval: i ? intervalView(i, prefs) : r.is_full ? null : { available: false, reason: 'partial_fill', distance: null, volume: null, economy: null },
  };
}

export interface EconomySummary {
  intervalCount: number;
  distance: Quantity<DistanceUnit>; volume: Quantity<VolumeUnit>;
  economy: Quantity<Preferences['economyUnit']> | null;
}

export class FuelService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #now: () => Date;
  constructor(pool: pg.Pool, vehicles: VehicleService, now: () => Date = () => new Date()) { this.#pool = pool; this.#vehicles = vehicles; this.#now = now; }

  async #rows(q: Pick<pg.Pool, 'query'>, vehicleId: Id): Promise<FillUpRow[]> {
    return (await q.query<FillUpRow>(`SELECT ${COLS} FROM fill_ups WHERE vehicle_id = $1 ORDER BY ${ORDER}`, [vehicleId])).rows;
  }

  async list(p: Principal, vehicleId: unknown, opts: { limit?: number; offset?: number } = {}): Promise<{ items: FillUpView[]; total: number }> {
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    const [rows, prefs] = await Promise.all([this.#rows(this.#pool, v.id), getPreferences(this.#pool, p.userId)]);
    const byEnd = new Map(intervals(rows.map(toFill)).map((i) => [i.endId, i]));
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000), offset = Math.max(opts.offset ?? 0, 0);
    const newestFirst = rows.toReversed().slice(offset, offset + limit);
    return { items: newestFirst.map((r) => view(r, v, prefs, byEnd)), total: rows.length };
  }

  async get(p: Principal, vehicleId: unknown, fillUpId: unknown): Promise<FillUpView> {
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    return this.#one(this.#pool, p, v, fillUpId);
  }

  async #one(q: Pick<pg.Pool, 'query'>, p: Principal, v: VehicleAccess, fillUpId: unknown): Promise<FillUpView> {
    if (!isUuid(fillUpId)) throw notFound();
    const [rows, prefs] = await Promise.all([this.#rows(q, v.id), getPreferences(q, p.userId)]);
    const row = rows.find((r) => r.id === fillUpId);
    if (!row) throw notFound();
    return view(row, v, prefs, new Map(intervals(rows.map(toFill)).map((i) => [i.endId, i])));
  }

  async #write<T>(p: Principal, vehicleId: unknown, fn: (c: pg.PoolClient, v: VehicleAccess) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true); // row lock: serialises with every other change to this vehicle
      if (v.role === 'viewer') throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Your role does not allow changing fuel records.');
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived. Unarchive it to change its records.');
      const out = await fn(c, v);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'fill_ups_no_duplicate') {
        throw new HttpProblem(409, 'duplicate_fill_up', 'Conflict', 'A fill-up with the same time and odometer reading already exists for this vehicle.');
      }
      throw e;
    } finally { c.release(); }
  }

  /** The odometer may never run backwards in time: a reading must sit between its chronological neighbours. */
  async #checkSequence(c: pg.PoolClient, vehicleId: Id, f: ParsedFillUp, selfId: Id | null): Promise<void> {
    const { rows } = await c.query<{ lo: string | null; hi: string | null }>(
      `SELECT (SELECT max(odometer_km)::text FROM fill_ups WHERE vehicle_id = $1 AND occurred_at < $2 AND ($3::uuid IS NULL OR id <> $3)) AS lo,
              (SELECT min(odometer_km)::text FROM fill_ups WHERE vehicle_id = $1 AND occurred_at > $2 AND ($3::uuid IS NULL OR id <> $3)) AS hi`,
      [vehicleId, f.occurredAt, selfId]);
    const { lo, hi } = rows[0]!;
    const km = Dec.parse(f.odometerKm.toFixed(6));
    const show = (v: string) => `${fromKm(Dec.parse(v), f.odometerUnit).toDecimal(1)} ${f.odometerUnit}`;
    if (lo !== null && km.cmp(Dec.parse(lo)) < 0) throw new HttpProblem(422, 'odometer_out_of_sequence', 'Validation failed', `The odometer reading is lower than an earlier record (${show(lo)}).`);
    if (hi !== null && km.cmp(Dec.parse(hi)) > 0) throw new HttpProblem(422, 'odometer_out_of_sequence', 'Validation failed', `The odometer reading is higher than a later record (${show(hi)}).`);
  }

  async #audit(c: pg.PoolClient, p: Principal, action: string, vehicleId: Id, fillUpId: Id): Promise<void> {
    await c.query("INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,$3,'vehicle',$4,$5)",
      [uuidv7(), p.userId, action, vehicleId, JSON.stringify({ fillUpId })]);
  }

  /** Insert without authorization or audit; used by create and by import inside their own transaction. */
  async insertParsed(c: pg.PoolClient, vehicleId: Id, f: ParsedFillUp, createdBy: Id): Promise<Id> {
    await this.#checkSequence(c, vehicleId, f, null);
    const id = uuidv7();
    await c.query(
      `INSERT INTO fill_ups (id, vehicle_id, occurred_at, odometer_input, odometer_unit, odometer_km, volume_input, volume_unit, volume_l,
         is_full, missed_previous, cost_amount, cost_currency, exchange_rate, reporting_amount, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, vehicleId, f.occurredAt, f.odometer, f.odometerUnit, f.odometerKm.toFixed(6), f.volume, f.volumeUnit, f.volumeL.toFixed(9), f.full, f.missedPrevious,
        f.cost?.amount ?? null, f.cost?.currency ?? null, f.cost?.exchangeRate ?? null, f.cost?.reportingAmount ?? null, f.notes, createdBy]);
    return id;
  }

  async create(p: Principal, vehicleId: unknown, body: unknown): Promise<FillUpView> {
    const b = obj(body, FILL_UP_FIELDS);
    return this.#write(p, vehicleId, async (c, v) => {
      const id = await this.insertParsed(c, v.id, parseFillUp(b, v.currency, this.#now()), p.userId);
      await this.#audit(c, p, 'fill_up.create', v.id, id);
      return this.#one(c, p, v, id);
    });
  }

  /** Partial update: the stored record is merged with the patch and validated again as a whole. */
  async update(p: Principal, vehicleId: unknown, fillUpId: unknown, body: unknown): Promise<FillUpView> {
    const patch = obj(body, FILL_UP_FIELDS);
    if (!Object.keys(patch).length) throw invalid('At least one field is required.');
    return this.#write(p, vehicleId, async (c, v) => {
      if (!isUuid(fillUpId)) throw notFound();
      const cur = (await c.query<FillUpRow>(`SELECT ${COLS} FROM fill_ups WHERE id = $1 AND vehicle_id = $2`, [fillUpId, v.id])).rows[0];
      if (!cur) throw notFound();
      const f = parseFillUp({ ...rowToBody(cur), ...patch }, v.currency, this.#now());
      await this.#checkSequence(c, v.id, f, cur.id);
      await c.query(
        `UPDATE fill_ups SET occurred_at = $2, odometer_input = $3, odometer_unit = $4, odometer_km = $5, volume_input = $6, volume_unit = $7, volume_l = $8,
           is_full = $9, missed_previous = $10, cost_amount = $11, cost_currency = $12, exchange_rate = $13, reporting_amount = $14, notes = $15, updated_at = now()
         WHERE id = $1`,
        [cur.id, f.occurredAt, f.odometer, f.odometerUnit, f.odometerKm.toFixed(6), f.volume, f.volumeUnit, f.volumeL.toFixed(9), f.full, f.missedPrevious,
          f.cost?.amount ?? null, f.cost?.currency ?? null, f.cost?.exchangeRate ?? null, f.cost?.reportingAmount ?? null, f.notes]);
      await this.#audit(c, p, 'fill_up.update', v.id, cur.id);
      return this.#one(c, p, v, cur.id);
    });
  }

  async remove(p: Principal, vehicleId: unknown, fillUpId: unknown): Promise<void> {
    await this.#write(p, vehicleId, async (c, v) => {
      if (!isUuid(fillUpId)) throw notFound();
      const r = await c.query('DELETE FROM fill_ups WHERE id = $1 AND vehicle_id = $2', [fillUpId, v.id]);
      if (!r.rowCount) throw notFound();
      await this.#audit(c, p, 'fill_up.delete', v.id, fillUpId);
    });
  }

  /** Raw ordered rows for export. The caller has already authorized. */
  exportRows(q: Pick<pg.Pool, 'query'>, vehicleId: Id): Promise<FillUpRow[]> { return this.#rows(q, vehicleId); }

  /**
   * Aggregate economy for one vehicle in a window, in the viewer's units. No
   * authorization here: callers are stats (after access) and comparisons
   * (after the friendship and opt-in checks).
   */
  async summary(vehicleId: Id, w: Window, prefs: Preferences): Promise<EconomySummary & { cost: Dec; costDistanceKm: Dec; all: Interval[] }> {
    const all = intervals((await this.#rows(this.#pool, vehicleId)).map(toFill));
    const a = aggregate(all.filter((i) => inWindow(i.endAt, w)));
    const e = economy(a.distanceKm, a.volumeL, prefs.economyUnit);
    return {
      intervalCount: a.intervalCount,
      distance: { value: fromKm(a.distanceKm, prefs.distanceUnit).toFixed(DISPLAY_SCALE.distance), unit: prefs.distanceUnit },
      volume: { value: fromLitres(a.volumeL, prefs.volumeUnit).toFixed(DISPLAY_SCALE.volume), unit: prefs.volumeUnit },
      economy: e && { value: e.toFixed(DISPLAY_SCALE.economy), unit: prefs.economyUnit },
      cost: a.cost, costDistanceKm: a.costDistanceKm, all,
    };
  }

  async stats(p: Principal, vehicleId: unknown, w: Window) {
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    const prefs = await getPreferences(this.#pool, p.userId);
    const [s, spend] = await Promise.all([
      this.summary(v.id, w, prefs),
      this.#pool.query<{ fills: number; costed: number; total: string | null }>(
        `SELECT count(*)::int AS fills, count(reporting_amount)::int AS costed, sum(reporting_amount)::text AS total FROM fill_ups
          WHERE vehicle_id = $1 AND ($2::timestamptz IS NULL OR occurred_at >= $2) AND ($3::timestamptz IS NULL OR occurred_at < $3)`, [v.id, w.from, w.to]),
    ]);
    const inWin = s.all.filter((i) => inWindow(i.endAt, w));
    const per = distanceUnitOf(prefs.economyUnit);
    const perDistance = s.costDistanceKm.isZero() ? null : s.cost.div(fromKm(s.costDistanceKm, per));
    return {
      vehicleId: v.id,
      window: { from: w.from?.toISOString() ?? null, to: w.to?.toISOString() ?? null },
      fillCount: spend.rows[0]!.fills,
      intervalCount: s.intervalCount,
      unavailableIntervalCount: inWin.filter((i) => !i.available && i.startId !== null).length,
      distance: s.distance, volume: s.volume, economy: s.economy,
      // Spending covers every costed purchase in the window; it is not an efficiency figure.
      spend: { amount: money(Dec.parse(spend.rows[0]!.total ?? '0'), v.currency), currency: v.currency, costedFillCount: spend.rows[0]!.costed },
      costPerDistance: perDistance && { value: perDistance.toFixed(currencyScale(v.currency) + 2), currency: v.currency, per },
      series: inWin.filter((i) => i.available).map((i) => ({ at: i.endAt.toISOString(), economy: economy(i.distanceKm, i.volumeL, prefs.economyUnit)!.toFixed(DISPLAY_SCALE.economy) })),
    };
  }
}
