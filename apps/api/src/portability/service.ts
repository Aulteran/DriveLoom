// Vehicle-level export and import (milestone 1.6). Formats:
//   CSV  "driveloom fill-ups v1": one row per purchase, entered values and units.
//   JSON "driveloom.vehicle" v1: vehicle description plus the same purchases.
// Neither carries ids, members or users, so a file moves between instances and
// lands under the importing user's own permissions. Import validates every row
// with the same rules as manual entry, runs inside one transaction, skips
// purchases that already exist, and is all-or-nothing. A dry run executes the
// same statements and rolls back.
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import { HttpProblem } from '../http/problem.ts';
import { invalid, obj } from '../http/validate.ts';
import { uuidv7 } from '../ids.ts';
import type { Principal } from '../identity.ts';
import type { Id } from '../types.ts';
import { parseFillUp, rowToBody, type FillUpRow, type FuelService, type ParsedFillUp } from '../fuel/service.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { Vehicle, VehicleAccess } from '../vehicles/types.ts';
import { CsvError, denormalise, neutralise, parseCsv, toCsv } from './csv.ts';

export const EXPORT_FORMAT = 'driveloom.vehicle';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export const CSV_COLUMNS = [
  'occurred_at', 'odometer', 'odometer_unit', 'volume', 'volume_unit', 'full', 'missed_previous',
  'cost_amount', 'cost_currency', 'exchange_rate', 'reporting_amount', 'reporting_currency', 'notes',
] as const;
const REQUIRED_COLUMNS = ['occurred_at', 'odometer', 'odometer_unit', 'volume', 'volume_unit'] as const;

export interface ImportReport {
  dryRun: boolean;
  committed: boolean;
  summary: { total: number; created: number; duplicates: number; invalid: number };
  /** `row` counts data rows from 1 (CSV line number minus the header). At most 100 are listed. */
  errors: { row: number; code: string; message: string }[];
  vehicle?: Vehicle;
}

interface Candidate { row: number; body: Record<string, unknown>; reportingCurrency: string | null }

const csvRow = (r: FillUpRow, currency: string): string[] => [
  r.occurred_at.toISOString(), r.odometer_input, r.odometer_unit, r.volume_input, r.volume_unit, String(r.is_full), String(r.missed_previous),
  r.cost_amount ?? '', r.cost_currency ?? '', r.exchange_rate ?? '', r.reporting_amount ?? '', r.cost_amount === null ? '' : currency, neutralise(r.notes),
];

function csvCandidates(text: unknown): Candidate[] {
  if (typeof text !== 'string') throw invalid('data must be CSV text.');
  let rows: string[][];
  try { rows = parseCsv(text, MAX_IMPORT_ROWS); } catch (e) {
    if (e instanceof CsvError) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `The CSV could not be read: ${e.message}.`);
    throw e;
  }
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'The file is empty.');
  const unknown = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `Unknown column: ${unknown[0]}.`);
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `Missing column: ${missing[0]}.`);
  if (new Set(header).size !== header.length) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'A column appears twice.');
  const truthy = (v: string, dflt: boolean): unknown => (v === '' ? dflt : v.toLowerCase() === 'true' ? true : v.toLowerCase() === 'false' ? false : v);
  return rows.slice(1).map((cells, i) => {
    const get = (c: string) => (cells[header.indexOf(c)] ?? '').trim();
    const amount = get('cost_amount');
    return {
      row: i + 1,
      reportingCurrency: get('reporting_currency') || null,
      body: {
        occurredAt: get('occurred_at'),
        odometer: { value: get('odometer'), unit: get('odometer_unit') },
        volume: { value: get('volume'), unit: get('volume_unit') },
        full: truthy(get('full'), true), missedPrevious: truthy(get('missed_previous'), false),
        notes: denormalise(cells[header.indexOf('notes')] ?? ''),
        cost: amount === '' ? null : { amount, currency: get('cost_currency'), exchangeRate: get('exchange_rate') || null, reportingAmount: get('reporting_amount') || null },
      },
    };
  });
}

function jsonDocument(data: unknown): { vehicle: Record<string, unknown>; candidates: Candidate[] } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'data must be a DriveLoom vehicle export.');
  const d = data as Record<string, unknown>;
  if (d['format'] !== EXPORT_FORMAT) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `This is not a ${EXPORT_FORMAT} export.`);
  if (d['version'] !== EXPORT_VERSION) throw new HttpProblem(422, 'unsupported_version', 'Validation failed', `Export version ${String(d['version'])} is not supported by this server (supported: ${EXPORT_VERSION}).`);
  const vehicle = obj(d['vehicle'], ['name', 'make', 'model', 'year', 'odometerUnit', 'currency'], 'vehicle');
  if (!Array.isArray(d['fillUps'])) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'fillUps must be a list.');
  if (d['fillUps'].length > MAX_IMPORT_ROWS) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `too many rows (limit ${MAX_IMPORT_ROWS}).`);
  const currency = typeof vehicle['currency'] === 'string' ? vehicle['currency'] : null;
  return { vehicle, candidates: d['fillUps'].map((body, i) => ({ row: i + 1, body: body as Record<string, unknown>, reportingCurrency: currency })) };
}

export class PortabilityService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #fuel: FuelService;
  readonly #now: () => Date;
  constructor(pool: pg.Pool, vehicles: VehicleService, fuel: FuelService, now: () => Date = () => new Date()) {
    this.#pool = pool; this.#vehicles = vehicles; this.#fuel = fuel; this.#now = now;
  }

  /** Any member may export: it contains nothing a viewer cannot already read. */
  async exportVehicle(p: Principal, vehicleId: unknown, format: string | null): Promise<{ filename: string; contentType: string; data: string }> {
    if (format !== 'csv' && format !== 'json') throw invalid("format must be 'csv' or 'json'.");
    const v = await this.#vehicles.get(p, vehicleId);
    const rows = await this.#fuel.exportRows(this.#pool, v.id);
    await this.#pool.query("INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,'vehicle.export','vehicle',$3,$4)",
      [uuidv7(), p.userId, v.id, JSON.stringify({ format, rows: rows.length })]);
    const stem = `driveloom-${v.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'vehicle'}-${this.#now().toISOString().slice(0, 10)}`;
    if (format === 'csv') return { filename: `${stem}.csv`, contentType: 'text/csv; charset=utf-8', data: toCsv(CSV_COLUMNS, rows.map((r) => csvRow(r, v.currency))) };
    const doc = {
      format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: this.#now().toISOString(),
      vehicle: { name: v.name, make: v.make, model: v.model, year: v.year, odometerUnit: v.odometerUnit, currency: v.currency },
      fillUps: rows.map(rowToBody),
    };
    return { filename: `${stem}.json`, contentType: 'application/json', data: JSON.stringify(doc, null, 2) };
  }

  async #run(c: pg.PoolClient, p: Principal, v: Pick<VehicleAccess, 'id' | 'currency'>, candidates: Candidate[], dryRun: boolean): Promise<ImportReport> {
    const errors: ImportReport['errors'] = [];
    const fail = (row: number, e: unknown) => {
      if (!(e instanceof HttpProblem)) throw e;
      if (errors.length < 100) errors.push({ row, code: e.code, message: e.message });
      invalidCount++;
    };
    let invalidCount = 0, created = 0, duplicates = 0;
    const parsed: { row: number; f: ParsedFillUp }[] = [];
    for (const cand of candidates) {
      try {
        const body = obj(cand.body, ['occurredAt', 'odometer', 'volume', 'full', 'missedPrevious', 'cost', 'notes'], 'Row');
        // A reporting amount is only meaningful in the currency it was computed for.
        const cost = body['cost'] as Record<string, unknown> | null | undefined;
        if (cost && typeof cost === 'object' && cand.reportingCurrency !== v.currency) body['cost'] = { amount: cost['amount'], currency: cost['currency'] };
        parsed.push({ row: cand.row, f: parseFillUp(body, v.currency, this.#now()) });
      } catch (e) { fail(cand.row, e); }
    }
    // Chronological order, so each row is checked against everything before it.
    parsed.sort((a, b) => a.f.occurredAt.getTime() - b.f.occurredAt.getTime() || a.f.odometerKm.cmp(b.f.odometerKm));
    for (const { row, f } of parsed) {
      const dup = await c.query('SELECT 1 FROM fill_ups WHERE vehicle_id = $1 AND occurred_at = $2 AND odometer_km = $3', [v.id, f.occurredAt, Dec.parse(f.odometerKm.toFixed(6)).toFixed(6)]);
      if (dup.rowCount) { duplicates++; continue; }
      try { await this.#fuel.insertParsed(c, v.id, f, p.userId); created++; } catch (e) { fail(row, e); }
    }
    const committed = !dryRun && invalidCount === 0;
    if (committed) {
      await c.query("INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,'vehicle.import','vehicle',$3,$4)",
        [uuidv7(), p.userId, v.id, JSON.stringify({ created, duplicates })]);
    }
    return { dryRun, committed, summary: { total: candidates.length, created, duplicates, invalid: invalidCount }, errors };
  }

  async #transaction(dryRun: boolean, fn: (c: pg.PoolClient) => Promise<ImportReport>): Promise<ImportReport> {
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const report = await fn(c);
      await c.query(report.committed ? 'COMMIT' : 'ROLLBACK');
      if (!dryRun && !report.committed) throw new HttpProblem(422, 'import_invalid', 'Validation failed', 'Nothing was imported because some rows are invalid.', { report });
      return report;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  #request(body: unknown, keys: string[]): { b: Record<string, unknown>; dryRun: boolean } {
    const b = obj(body, keys);
    if (b['dryRun'] !== undefined && typeof b['dryRun'] !== 'boolean') throw invalid('dryRun must be true or false.');
    return { b, dryRun: b['dryRun'] !== false }; // preview unless the caller explicitly commits
  }

  /** Import purchases into a vehicle the caller can edit. */
  async importInto(p: Principal, vehicleId: unknown, body: unknown): Promise<ImportReport> {
    const { b, dryRun } = this.#request(body, ['format', 'data', 'dryRun']);
    const candidates = b['format'] === 'csv' ? csvCandidates(b['data']) : b['format'] === 'json' ? jsonDocument(b['data']).candidates : (() => { throw invalid("format must be 'csv' or 'json'."); })();
    return this.#transaction(dryRun, async (c) => {
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      if (v.role === 'viewer') throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Your role does not allow importing into this vehicle.');
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived.');
      return this.#run(c, p, v, candidates, dryRun);
    });
  }

  /** Create a new vehicle, owned by the caller, from a JSON export. */
  async importNew(p: Principal, body: unknown): Promise<ImportReport> {
    const { b, dryRun } = this.#request(body, ['data', 'dryRun']);
    const doc = jsonDocument(b['data']);
    return this.#transaction(dryRun, async (c) => {
      const vehicle = await this.#vehicles.create(p, doc.vehicle as never, c);
      const report = await this.#run(c, p, { id: vehicle.id as Id, currency: vehicle.currency }, doc.candidates, dryRun);
      return { ...report, ...(report.committed ? { vehicle } : {}) };
    });
  }
}
