// Vehicle-level export and import (milestone 1.6). Formats:
//   CSV  "driveloom fill-ups v1": one row per purchase, entered values and units.
//   JSON "driveloom.vehicle" v1: vehicle description plus the same purchases and,
//   optionally, `serviceVisits` (added later without a version bump: older files
//   simply lack it and older readers ignore it) and `maintenanceTasks` (likewise;
//   items point at them with `taskRef`; only vehicle-wide snoozes travel, never
//   personal ones). Service data is exported even when the Service module is
//   off, so nothing is stranded.
// Neither carries ids, members or users, so a file moves between instances and
// lands under the importing user's own permissions. Import validates every row
// with the same rules as manual entry, runs inside one transaction, skips
// purchases that already exist, and is all-or-nothing. A dry run executes the
// same statements and rolls back.
import { auditAs } from '../audit.ts';
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import { HttpProblem } from '../http/problem.ts';
import { invalid, obj } from '../http/validate.ts';
import type { Principal } from '../identity.ts';
import { digestOf, withIdempotency, type Idem } from '../auth/idempotency.ts';
import { consumePreview, issuePreview } from '../auth/import-previews.ts';
import { grantsAllow, type KeyGrants, type KeyRequirement } from '../auth/api-key-policy.ts';
import { recheckKeyInTx, requireKeyGrant } from '../auth/api-key-auth.ts';
import { recordKeyActivity } from '../auth/api-keys.ts';
import { isModuleEnabled, requireModule } from '../modules.ts';
import type { Id } from '../types.ts';
import { parseFillUp, rowToBody, type FillUpRow, type FuelService, type ParsedFillUp } from '../fuel/service.ts';
import { insertImported, parseImportAttachments, type ParsedAttachment } from '../service/attachments.ts';
import { parseVisit, VISIT_FIELDS, type ParsedVisit, type ServiceService } from '../service/service.ts';
import { assertTaskLinks, exportTasks, findDuplicateTask, insertTask, insertVehicleSnooze, parseImportTask, MAX_TASKS, type ParsedImportTask } from '../service/maintenance.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { Vehicle, VehicleAccess } from '../vehicles/types.ts';
import { canEditVehicle } from '../vehicles/permissions.ts';
import { CsvError, denormalise, neutralise, parseCsv, toCsv } from './csv.ts';

export const EXPORT_FORMAT = 'driveloom.vehicle';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
/** JSON imports may carry base64 attachments, so their body limit is larger. */
export const MAX_IMPORT_JSON_BYTES = 96 * 1024 * 1024;

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
  /**
   * Present when the JSON file carried `serviceVisits`. Their failures are also counted in `summary.invalid` and listed in `errors` with a "Service visit" prefix.
   * `conflicts` (counted in `invalid`): visits whose `externalId` exists with different content. `possibleDuplicates`: imported visits that look like a stored
   * one (same date, odometer, provider and items) and were NOT skipped. `records`: the outcome of each visit that carried an `externalId`.
   */
  serviceVisits?: { total: number; created: number; duplicates: number; invalid: number; conflicts?: number; possibleDuplicates?: { row: number; visitId: Id }[]; records?: VisitRecord[] };
  /** Present when the JSON file carried `maintenanceTasks`. Failures are also counted in `summary.invalid` and listed with a "Maintenance task" prefix. */
  maintenanceTasks?: { total: number; created: number; duplicates: number; invalid: number };
  /** Only on a dry run made with an API key that found nothing invalid: send it back as `previewToken` to commit exactly this payload. Valid for 15 minutes, once. */
  previewToken?: string;
  previewExpiresAt?: string;
}
export interface VisitRecord { row: number; externalId: string; outcome: 'created' | 'duplicate' | 'conflict'; visitId: Id }

interface Document { vehicle: Record<string, unknown>; candidates: Candidate[]; visits: Record<string, unknown>[]; tasks: unknown[] }
interface Candidate { row: number; body: Record<string, unknown>; reportingCurrency: string | null }

const csvRow = (r: FillUpRow, currency: string): string[] => [
  r.occurred_at.toISOString(), r.odometer_input, r.odometer_unit, r.volume_input, r.volume_unit, String(r.is_full), String(r.missed_previous),
  r.cost_amount ?? '', r.cost_currency ?? '', r.exchange_rate ?? '', r.reporting_amount ?? '', r.cost_amount === null ? '' : currency, neutralise(r.notes),
];

function csvCandidates(text: unknown): Candidate[] {
  if (typeof text !== 'string') throw invalid('data must be CSV text.');
  // The route allows a larger body for JSON files that embed attachments; CSV stays small.
  if (text.length > MAX_IMPORT_BYTES) throw new HttpProblem(413, 'body_too_large', 'Request body too large');
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

function jsonDocument(data: unknown): Document {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'data must be a DriveLoom vehicle export.');
  const d = data as Record<string, unknown>;
  if (d['format'] !== EXPORT_FORMAT) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `This is not a ${EXPORT_FORMAT} export.`);
  if (d['version'] !== EXPORT_VERSION) throw new HttpProblem(422, 'unsupported_version', 'Validation failed', `Export version ${String(d['version'])} is not supported by this server (supported: ${EXPORT_VERSION}).`);
  const vehicle = obj(d['vehicle'], ['name', 'make', 'model', 'year', 'plateRegion', 'plateNumber', 'vin', 'odometerUnit', 'currency'], 'vehicle');
  // A scoped export leaves out what its key may not read and says so in `omittedSections`; that file imports without the list.
  const fillUps = d['fillUps'] === undefined && Array.isArray(d['omittedSections']) && d['omittedSections'].includes('fillUps') ? [] : d['fillUps'];
  if (!Array.isArray(fillUps)) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'fillUps must be a list.');
  if (fillUps.length > MAX_IMPORT_ROWS) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `too many rows (limit ${MAX_IMPORT_ROWS}).`);
  const visits = d['serviceVisits'] === undefined ? [] : d['serviceVisits'];
  if (!Array.isArray(visits)) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'serviceVisits must be a list.');
  if (visits.length > MAX_IMPORT_ROWS) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `too many service visits (limit ${MAX_IMPORT_ROWS}).`);
  const tasks = d['maintenanceTasks'] === undefined ? [] : d['maintenanceTasks'];
  if (!Array.isArray(tasks)) throw new HttpProblem(422, 'import_malformed', 'Validation failed', 'maintenanceTasks must be a list.');
  if (tasks.length > MAX_TASKS) throw new HttpProblem(422, 'import_malformed', 'Validation failed', `too many maintenance tasks (limit ${MAX_TASKS}).`);
  const currency = typeof vehicle['currency'] === 'string' ? vehicle['currency'] : null;
  return { vehicle, visits: visits as Record<string, unknown>[], tasks, candidates: fillUps.map((body, i) => ({ row: i + 1, body: body as Record<string, unknown>, reportingCurrency: currency })) };
}

/** Replace each item's `taskRef` (an export-local label) with the id of the task it was imported as. An unknown ref is a validation error; a literal `taskId` is left for the vehicle check to reject. */
function withTaskIds(visit: Record<string, unknown>, refs: Map<string, Id>): Record<string, unknown> {
  if (!Array.isArray(visit['items'])) return visit;
  return {
    ...visit,
    items: visit['items'].map((it, i) => {
      if (typeof it !== 'object' || it === null || Array.isArray(it) || !('taskRef' in it)) return it;
      const { taskRef, ...rest } = it as Record<string, unknown>;
      if (taskRef === null || taskRef === undefined) return rest;
      const id = typeof taskRef === 'string' ? refs.get(taskRef) : undefined;
      if (!id) throw invalid(`items[${i}].taskRef does not match a task in maintenanceTasks.`);
      return { ...rest, taskId: id };
    }),
  };
}

/** A section of the JSON document, named as its key in the file. Fuel is `fillUps`. */
export type Section = 'fillUps' | 'serviceVisits' | 'maintenanceTasks';

/** What an import will write, read from the payload alone (before any write), so permissions can be checked for all of it first. */
function requiredGrants(doc: Pick<Document, 'candidates' | 'visits' | 'tasks'>, creating: boolean): KeyRequirement[] {
  const need: KeyRequirement[] = [];
  if (creating) need.push({ module: 'vehicle_create', action: 'create' });
  if (doc.candidates.length) need.push({ module: 'fuel', action: 'create' });
  // Visits, their items and their receipts are one section: service create covers all of it.
  if (doc.visits.length) need.push({ module: 'service', action: 'create' });
  if (doc.tasks.length) need.push({ module: 'maintenance', action: 'create' });
  // Linking an item to a task (by `taskRef` or a task id) is choosing that task: it needs maintenance read, as on the visit endpoints.
  const links = doc.visits.some((vis) => Array.isArray(vis['items']) && vis['items'].some((it) => typeof it === 'object' && it !== null && ((it as Record<string, unknown>)['taskRef'] != null || (it as Record<string, unknown>)['taskId'] != null)));
  if (links) need.push({ module: 'maintenance', action: 'read' });
  return need;
}

/** The whole request is refused (403) when anything it contains is outside the key's grants; every missing grant is listed. */
function requireAll(grants: KeyGrants, need: KeyRequirement[]): void {
  const missing = need.filter((r) => !grantsAllow(grants, r)).map((r) => `${r.module}.${r.action}`);
  const unique = [...new Set(missing)];
  if (unique.length) {
    throw new HttpProblem(403, 'insufficient_scope', 'Insufficient scope',
      `This API key does not allow everything this import contains, so nothing was imported. Missing: ${unique.join(', ')}.`, { required: unique[0]!, missing: unique });
  }
}

type Gate = (c: pg.PoolClient, at: { target: string; vehicleId: Id | null }, work: () => Promise<ImportReport>) => Promise<ImportReport>;

/** Created record ids by kind, for the key's per-record history. */
interface Created { fillUps: Id[]; serviceVisits: Id[]; maintenanceTasks: Id[]; receipts: Id[] }
const ATTRIBUTION: { kind: keyof Created; action: string; type: string }[] = [
  { kind: 'fillUps', action: 'fill_up.import', type: 'fill_up' }, { kind: 'serviceVisits', action: 'service_visit.import', type: 'service_visit' },
  { kind: 'receipts', action: 'service_attachment.import', type: 'service_attachment' }, { kind: 'maintenanceTasks', action: 'maintenance_task.import', type: 'maintenance_task' },
];
const IDS_PER_ACTIVITY_ROW = 200;

export class PortabilityService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #fuel: FuelService;
  readonly #service: ServiceService;
  readonly #now: () => Date;
  constructor(pool: pg.Pool, vehicles: VehicleService, fuel: FuelService, service: ServiceService, now: () => Date = () => new Date()) {
    this.#pool = pool; this.#vehicles = vehicles; this.#fuel = fuel; this.#service = service; this.#now = now;
  }

  /**
   * Any member may export: it contains nothing a viewer cannot already read. An API key gets only the sections it may read:
   * vehicle details (the entry grant, vehicle_info.read), `fillUps` (fuel.read), `serviceVisits` with their items and receipts
   * (service.read and the Service module on) and `maintenanceTasks` (maintenance.read and the Service module on). A section
   * left out is absent and named in `omittedSections`, never an empty list that looks complete; item links (`taskRef`) to tasks
   * the key may not read are dropped. CSV is fuel only, so it needs fuel.read.
   */
  async exportVehicle(p: Principal, vehicleId: unknown, format: string | null): Promise<{ filename: string; contentType: string; data: string }> {
    if (format !== 'csv' && format !== 'json') throw invalid("format must be 'csv' or 'json'.");
    const v = await this.#vehicles.get(p, vehicleId);
    const keyed = p.kind === 'api_key';
    if (format === 'csv') requireKeyGrant(p, { module: 'fuel', action: 'read' });
    const moduleOn = !keyed || (await isModuleEnabled(this.#pool, 'service'));
    const may = (module: 'fuel' | 'service' | 'maintenance'): boolean => !keyed || grantsAllow(p.apiKey.grants, { module, action: 'read' });
    const want = { fillUps: may('fuel'), serviceVisits: may('service') && moduleOn, maintenanceTasks: may('maintenance') && moduleOn };
    const omitted = (Object.keys(want) as Section[]).filter((s) => !want[s]);
    const rows = want.fillUps ? await this.#fuel.exportRows(this.#pool, v.id) : [];
    // Deliberately not behind the module switch for sessions: recorded service data is always exportable by the person who owns it.
    const visits = format === 'json' && want.serviceVisits ? await this.#service.exportBodies(this.#pool, v.id, { taskRefs: want.maintenanceTasks }) : [];
    const tasks = format === 'json' && want.maintenanceTasks ? await exportTasks(this.#pool, v.id, this.#now()) : [];
    // Exports are reads: audited as before, never recorded as API key activity.
    await auditAs(this.#pool, p, { action: 'vehicle.export', subjectType: 'vehicle', subjectId: v.id, keyActivity: false,
      details: { format, rows: rows.length, ...(format === 'json' ? { serviceVisits: visits.length, maintenanceTasks: tasks.length } : {}), ...(keyed && format === 'json' ? { omittedSections: omitted } : {}) } });
    // Never derive the filename from plate or VIN.
    const label = v.name ?? [v.year, v.make, v.model].filter(Boolean).join(' ');
    const stem = `driveloom-${label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'vehicle'}-${this.#now().toISOString().slice(0, 10)}`;
    if (format === 'csv') return { filename: `${stem}.csv`, contentType: 'text/csv; charset=utf-8', data: toCsv(CSV_COLUMNS, rows.map((r) => csvRow(r, v.currency))) };
    const doc = {
      format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: this.#now().toISOString(),
      vehicle: {
        name: v.name, make: v.make, model: v.model, year: v.year,
        ...(v.plateRegion ? { plateRegion: v.plateRegion } : {}), ...(v.plateNumber ? { plateNumber: v.plateNumber } : {}), ...(v.vin ? { vin: v.vin } : {}),
        odometerUnit: v.odometerUnit, currency: v.currency },
      ...(want.fillUps ? { fillUps: rows.map(rowToBody) } : {}),
      ...(want.serviceVisits ? { serviceVisits: visits } : {}),
      ...(want.maintenanceTasks ? { maintenanceTasks: tasks } : {}),
      ...(keyed ? { omittedSections: omitted } : {}),
    };
    return { filename: `${stem}.json`, contentType: 'application/json', data: JSON.stringify(doc, null, 2) };
  }

  async #run(c: pg.PoolClient, p: Principal, v: Pick<VehicleAccess, 'id' | 'currency'>, candidates: Candidate[], visits: Record<string, unknown>[], tasks: unknown[], dryRun: boolean): Promise<ImportReport> {
    const errors: ImportReport['errors'] = [];
    const created: Created = { fillUps: [], serviceVisits: [], maintenanceTasks: [], receipts: [] };
    const keyed = p.kind === 'api_key';
    const fail = (row: number, e: unknown) => {
      if (!(e instanceof HttpProblem)) throw e;
      if (errors.length < 100) errors.push({ row, code: e.code, message: e.message });
      invalidCount++;
    };
    let invalidCount = 0, createdCount = 0, duplicates = 0;
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
      try { created.fillUps.push(await this.#fuel.insertParsed(c, v.id, f, p.userId)); createdCount++; } catch (e) { fail(row, e); }
    }
    // Maintenance tasks first, so visit items can link to them by `taskRef`. An identical task already on the vehicle is reused, not duplicated.
    let mt: ImportReport['maintenanceTasks'];
    const refs = new Map<string, Id>();
    if (tasks.length) {
      mt = { total: tasks.length, created: 0, duplicates: 0, invalid: 0 };
      const ok: ParsedImportTask[] = [];
      tasks.forEach((raw, i) => {
        try { ok.push(parseImportTask(raw, this.#now())); } catch (e) {
          if (!(e instanceof HttpProblem)) throw e;
          if (errors.length < 100) errors.push({ row: i + 1, code: e.code, message: `Maintenance task: ${e.message}` });
          invalidCount++; mt!.invalid++;
        }
      });
      let existing = Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM maintenance_tasks WHERE vehicle_id = $1', [v.id])).rows[0]!.n);
      for (const t of ok) {
        let id = await findDuplicateTask(c, v.id, t.f);
        if (id) mt.duplicates++;
        else {
          if (existing >= MAX_TASKS) { invalidCount++; mt.invalid++; if (errors.length < 100) errors.push({ row: 0, code: 'validation_failed', message: `Maintenance task: a vehicle allows at most ${MAX_TASKS} tasks.` }); continue; }
          id = await insertTask(c, v.id, t.f, p.userId, t.archived); mt.created++; existing++; created.maintenanceTasks.push(id);
          if (t.snooze) await insertVehicleSnooze(c, id, t.snooze, p.userId);
        }
        if (t.ref) refs.set(t.ref, id);
      }
    }
    let svc: ImportReport['serviceVisits'];
    if (visits.length) {
      svc = { total: visits.length, created: 0, duplicates: 0, invalid: 0 };
      const ok: { row: number; f: ParsedVisit; files: ParsedAttachment[] }[] = [];
      for (const [i, raw] of visits.entries()) {
        try {
          const { attachments, ...rest } = obj(raw, [...VISIT_FIELDS, 'attachments'], 'Service visit');
          const f = parseVisit(withTaskIds(rest, refs), v.currency, this.#now());
          await assertTaskLinks(c, v.id, f.items);
          ok.push({ row: i + 1, f, files: parseImportAttachments(attachments).items });
        } catch (e) {
          if (!(e instanceof HttpProblem)) throw e;
          if (errors.length < 100) errors.push({ row: i + 1, code: e.code, message: `Service visit: ${e.message}` });
          invalidCount++; svc!.invalid++;
        }
      }
      const record = (r: VisitRecord) => { if ((svc!.records ??= []).length < 100) svc!.records.push(r); };
      for (const { row, f, files } of ok) {
        // A source id is an identity: the same id again is the same visit. Identical is skipped, different is a conflict and nothing is written.
        if (f.externalId !== null) {
          const hit = await this.#service.byExternalId(c, v.id, f, files.map((x) => x.sha256));
          if (hit?.identical) { svc.duplicates++; record({ row, externalId: f.externalId, outcome: 'duplicate', visitId: hit.id }); continue; }
          if (hit) {
            svc.conflicts = (svc.conflicts ?? 0) + 1; svc.invalid++; invalidCount++;
            if (errors.length < 100) errors.push({ row, code: 'external_id_conflict', message: 'Service visit: a visit with this externalId already exists and differs from the one in the file.' });
            record({ row, externalId: f.externalId, outcome: 'conflict', visitId: hit.id });
            continue;
          }
        }
        // Without a source id the only evidence is a lookalike (same date, odometer, provider and items). Sessions keep skipping it silently; a key (or a visit that
        // has an id the instance has not seen) gets it reported as a possible duplicate and the visit is still imported, because two real visits on one day can look alike.
        const look = await this.#service.lookalike(c, v.id, f);
        if (look) {
          if (!keyed && f.externalId === null) { svc.duplicates++; continue; }
          (svc.possibleDuplicates ??= []).push({ row, visitId: look });
        }
        const visitId = await this.#service.insertParsed(c, v.id, v.currency, f, p.userId); svc.created++; created.serviceVisits.push(visitId);
        created.receipts.push(...(await insertImported(c, visitId, files, p.userId)));
        if (f.externalId !== null) record({ row, externalId: f.externalId, outcome: 'created', visitId });
      }
    }
    const committed = !dryRun && invalidCount === 0;
    if (committed) {
      await auditAs(c, p, { action: 'vehicle.import', subjectType: 'vehicle', subjectId: v.id,
        details: { created: createdCount, duplicates, ...(svc ? { serviceVisits: svc.created } : {}), ...(mt ? { maintenanceTasks: mt.created } : {}) } });
      // A key's history names every record it created (in bounded rows), in the same transaction as the records.
      if (p.kind === 'api_key') {
        for (const a of ATTRIBUTION) {
          const ids = created[a.kind];
          for (let i = 0; i < ids.length; i += IDS_PER_ACTIVITY_ROW) {
            await recordKeyActivity(c, { keyId: p.apiKey.id, userId: p.userId, keyName: p.apiKey.name, action: a.action, targetType: a.type, targetIds: ids.slice(i, i + IDS_PER_ACTIVITY_ROW),
              vehicleId: v.id, requestId: p.apiKey.requestId, metadata: { total: ids.length, part: Math.floor(i / IDS_PER_ACTIVITY_ROW) + 1 } });
          }
        }
      }
    }
    return { dryRun, committed, summary: { total: candidates.length, created: createdCount, duplicates, invalid: invalidCount }, errors, ...(svc ? { serviceVisits: svc } : {}), ...(mt ? { maintenanceTasks: mt } : {}) };
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
    const b = obj(body, [...keys, 'previewToken']);
    if (b['dryRun'] !== undefined && typeof b['dryRun'] !== 'boolean') throw invalid('dryRun must be true or false.');
    if (b['previewToken'] !== undefined && typeof b['previewToken'] !== 'string') throw invalid('previewToken must be text.');
    return { b, dryRun: b['dryRun'] !== false }; // preview unless the caller explicitly commits
  }

  /**
   * The key-only half of an import, shared by both routes. Before any write: every section of the payload needs its grant (the whole request is
   * refused otherwise, dry runs included). Inside the transaction: the grants are read again from the database, and a commit must present the
   * token of a preview of this very payload; it then runs once per Idempotency-Key. A dry run by a key returns that token.
   */
  async #guarded(p: Principal, doc: Pick<Document, 'candidates' | 'visits' | 'tasks'>, creating: boolean, dryRun: boolean, b: Record<string, unknown>, idem: Idem | undefined,
    body: (c: pg.PoolClient, gate: Gate) => Promise<ImportReport>): Promise<ImportReport> {
    const need = requiredGrants(doc, creating);
    if (p.kind === 'api_key') {
      requireAll(p.apiKey.grants, need);
      // Visits and tasks live in the Service module: its gate applies to a key's import as it does on the service endpoints.
      if (doc.visits.length || doc.tasks.length) await requireModule(this.#pool, 'service');
    }
    const digest = p.kind === 'api_key' ? digestOf({ format: b['format'] ?? 'json', data: b['data'] }) : '';
    let bound = '';
    const gate: Gate = async (c, at, work) => {
      if (p.kind !== 'api_key') return work();
      bound = at.target;
      // The grants as they are NOW: a reduction or revocation since the request began wins.
      requireAll((await recheckKeyInTx(c, p, at.vehicleId))!, need);
      if (dryRun) return work();
      return withIdempotency(c, p, idem, {
        operation: creating ? 'vehicle.import_new' : 'vehicle.import', target: at.target, payload: { digest }, now: this.#now(), status: 200,
        shrink: (r) => ({ ...r, ...(r.serviceVisits ? { serviceVisits: { total: r.serviceVisits.total, created: r.serviceVisits.created, duplicates: r.serviceVisits.duplicates, invalid: r.serviceVisits.invalid } } : {}) }),
      }, async () => {
        await consumePreview(c, p, b['previewToken'], at.target, digest, this.#now());
        return work();
      });
    };
    const out = await this.#transaction(dryRun, (c) => body(c, gate));
    // A preview writes no records and no audit; all it leaves is the short-lived, single-use token that the commit must present.
    if (p.kind === 'api_key' && dryRun && out.summary.invalid === 0 && bound) {
      const issued = await issuePreview(this.#pool, p, bound, digest, this.#now());
      return { ...out, previewToken: issued.token, previewExpiresAt: issued.expiresAt };
    }
    return out;
  }

  /** Import purchases (and, from JSON, service visits and maintenance tasks) into a vehicle the caller can edit. */
  async importInto(p: Principal, vehicleId: unknown, body: unknown, idem?: Idem): Promise<ImportReport> {
    const { b, dryRun } = this.#request(body, ['format', 'data', 'dryRun']);
    const doc: Pick<Document, 'candidates' | 'visits' | 'tasks'> = b['format'] === 'csv' ? { candidates: csvCandidates(b['data']), visits: [], tasks: [] } : b['format'] === 'json' ? jsonDocument(b['data']) : (() => { throw invalid("format must be 'csv' or 'json'."); })();
    return this.#guarded(p, doc, false, dryRun, b, idem, async (c, gate) => {
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      if (!canEditVehicle(v.role)) throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Your role does not allow importing into this vehicle.');
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived.');
      return gate(c, { target: `vehicle:${v.id}`, vehicleId: v.id }, () => this.#run(c, p, v, doc.candidates, doc.visits, doc.tasks, dryRun));
    });
  }

  /** Create a new vehicle, owned by the caller, from a JSON export. A key needs vehicle creation and the write grant of every section. */
  async importNew(p: Principal, body: unknown, idem?: Idem): Promise<ImportReport> {
    const { b, dryRun } = this.#request(body, ['data', 'dryRun']);
    const doc = jsonDocument(b['data']);
    return this.#guarded(p, doc, true, dryRun, b, idem, (c, gate) => gate(c, { target: 'new-vehicle', vehicleId: null }, async () => {
      const vehicle = await this.#vehicles.create(p, doc.vehicle as never, c);
      const r = await this.#run(c, p, { id: vehicle.id as Id, currency: vehicle.currency }, doc.candidates, doc.visits, doc.tasks, dryRun);
      return { ...r, ...(r.committed ? { vehicle } : {}) };
    }));
  }
}
