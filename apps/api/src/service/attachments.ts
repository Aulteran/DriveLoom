// Receipt and invoice attachments on service visits: PDF, JPEG or PNG files
// stored in Postgres next to the visit. The type is decided from the leading
// bytes, never from the client's claim or the extension. Bytes are only ever
// served through an authenticated, membership-checked download (never public).
// Authorization follows the visit: any member reads, canChangeVisit changes.
// Limits: attachment-limits.ts.
import { auditAs } from '../audit.ts';
import { idemFrom, idemHeaders, withIdempotency, type Idem } from '../auth/idempotency.ts';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { HttpRequest, RawBody, Route } from '../http/app.ts';
import { HttpProblem } from '../http/problem.ts';
import { invalid, obj } from '../http/validate.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import { requirePrincipal, type Principal } from '../identity.ts';
import { requireModule } from '../modules.ts';
import type { Id } from '../types.ts';
import { canChangeVisit } from '../vehicles/permissions.ts';
import type { VehicleService } from '../vehicles/service.ts';
import type { VehicleAccess } from '../vehicles/types.ts';
import {
  ATTACHMENT_TYPES, contentDisposition, defaultFileName, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_VISIT, sanitiseFileName, sniffAttachment, type AttachmentType,
} from './attachment-limits.ts';

type Q = Pick<pg.Pool, 'query'>;

export interface AttachmentView { id: Id; fileName: string; contentType: AttachmentType; sizeBytes: number; createdAt: string }
interface MetaRow { id: Id; visit_id: Id; file_name: string; content_type: AttachmentType; size_bytes: number; created_at: Date }
const META = 'id, visit_id, file_name, content_type, size_bytes, created_at';
const toView = (r: MetaRow): AttachmentView => ({ id: r.id, fileName: r.file_name, contentType: r.content_type, sizeBytes: r.size_bytes, createdAt: r.created_at.toISOString() });

const notFound = () => new HttpProblem(404, 'attachment_not_found', 'Attachment not found');
const visitNotFound = () => new HttpProblem(404, 'service_visit_not_found', 'Service visit not found');
const tooMany = () => new HttpProblem(422, 'attachment_limit', 'Validation failed', `A visit allows at most ${MAX_ATTACHMENTS_PER_VISIT} attachments.`);

/** Metadata (no bytes) for several visits at once. */
export async function attachmentsFor(q: Q, visitIds: Id[]): Promise<Map<Id, AttachmentView[]>> {
  const out = new Map<Id, AttachmentView[]>();
  if (!visitIds.length) return out;
  const { rows } = await q.query<MetaRow>(`SELECT ${META} FROM service_attachments WHERE visit_id = ANY($1::uuid[]) ORDER BY visit_id, created_at, id`, [visitIds]);
  for (const r of rows) (out.get(r.visit_id) ?? out.set(r.visit_id, []).get(r.visit_id)!).push(toView(r));
  return out;
}

/** Full attachments (with bytes, base64) for export. Not behind the module switch. */
export async function exportAttachments(q: Q, visitIds: Id[]): Promise<Map<Id, { fileName: string; contentType: string; sha256: string; data: string }[]>> {
  const out = new Map<Id, { fileName: string; contentType: string; sha256: string; data: string }[]>();
  if (!visitIds.length) return out;
  const { rows } = await q.query<{ visit_id: Id; file_name: string; content_type: string; sha256: string; data: Buffer }>(
    'SELECT visit_id, file_name, content_type, sha256, data FROM service_attachments WHERE visit_id = ANY($1::uuid[]) ORDER BY visit_id, created_at, id', [visitIds]);
  for (const r of rows) (out.get(r.visit_id) ?? out.set(r.visit_id, []).get(r.visit_id)!).push({ fileName: r.file_name, contentType: r.content_type, sha256: r.sha256, data: r.data.toString('base64') });
  return out;
}

export interface ParsedAttachment { fileName: string; contentType: AttachmentType; sha256: string; data: Buffer }

/** Validate the `attachments` list of an imported visit: magic bytes, sha256, size, count, in-file duplicates dropped. */
export function parseImportAttachments(raw: unknown): { items: ParsedAttachment[]; duplicates: number } {
  if (raw === undefined || raw === null) return { items: [], duplicates: 0 };
  if (!Array.isArray(raw)) throw invalid('attachments must be a list.');
  if (raw.length > MAX_ATTACHMENTS_PER_VISIT) throw tooMany();
  const items: ParsedAttachment[] = [];
  let duplicates = 0;
  raw.forEach((x, i) => {
    const a = obj(x, ['fileName', 'contentType', 'sha256', 'data'], `attachments[${i}]`);
    if (typeof a['data'] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a['data']) || a['data'].length % 4 !== 0) throw invalid(`attachments[${i}].data must be base64.`);
    if (a['data'].length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4) throw new HttpProblem(422, 'attachment_too_large', 'Validation failed', `attachments[${i}] is larger than ${MAX_ATTACHMENT_BYTES} bytes.`);
    const data = Buffer.from(a['data'], 'base64');
    if (!data.length || data.length > MAX_ATTACHMENT_BYTES) throw new HttpProblem(422, 'attachment_too_large', 'Validation failed', `attachments[${i}] must be 1 to ${MAX_ATTACHMENT_BYTES} bytes.`);
    const type = sniffAttachment(data);
    if (!type) throw new HttpProblem(422, 'attachment_type', 'Validation failed', `attachments[${i}] is not a PDF, JPEG or PNG file.`);
    if (a['contentType'] !== undefined && a['contentType'] !== type) throw new HttpProblem(422, 'attachment_type', 'Validation failed', `attachments[${i}].contentType does not match the file.`);
    const sha = createHash('sha256').update(data).digest('hex');
    if (a['sha256'] !== undefined && a['sha256'] !== sha) throw new HttpProblem(422, 'attachment_checksum', 'Validation failed', `attachments[${i}].sha256 does not match the file.`);
    if (items.some((y) => y.sha256 === sha)) { duplicates++; return; }
    items.push({ fileName: sanitiseFileName(a['fileName']) ?? defaultFileName(type), contentType: type, sha256: sha, data });
  });
  return { items, duplicates };
}

async function insert(c: Q, visitId: Id, f: ParsedAttachment, createdBy: Id): Promise<MetaRow> {
  const { rows } = await c.query<MetaRow>(
    `INSERT INTO service_attachments (id, visit_id, file_name, content_type, size_bytes, sha256, data, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${META}`,
    [uuidv7(), visitId, f.fileName, f.contentType, f.data.length, f.sha256, f.data, createdBy]);
  return rows[0]!;
}

/** Used by import, inside its transaction, without authorization or audit. */
export async function insertImported(c: Q, visitId: Id, items: ParsedAttachment[], createdBy: Id): Promise<Id[]> {
  const ids: Id[] = [];
  for (const f of items) ids.push((await insert(c, visitId, f, createdBy)).id);
  return ids;
}

export class AttachmentService {
  readonly #pool: pg.Pool;
  readonly #vehicles: VehicleService;
  readonly #now: () => Date;
  constructor(pool: pg.Pool, vehicles: VehicleService, now: () => Date = () => new Date()) { this.#pool = pool; this.#vehicles = vehicles; this.#now = now; }

  async #visit(q: Q, v: VehicleAccess, visitId: unknown, lock = false): Promise<{ id: Id; created_by: Id | null }> {
    if (!isUuid(visitId)) throw visitNotFound();
    const r = (await q.query<{ id: Id; created_by: Id | null }>(`SELECT id, created_by FROM service_visits WHERE id = $1 AND vehicle_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [visitId, v.id])).rows[0];
    if (!r) throw visitNotFound();
    return r;
  }

  async #write<T>(p: Principal, vehicleId: unknown, visitId: unknown, action: string, fn: (c: pg.PoolClient, visit: Id, v: VehicleAccess) => Promise<{ out: T; attachmentId: Id; extra?: Record<string, unknown> }>,
    wrap?: (c: pg.PoolClient, v: VehicleAccess, visit: Id, run: () => Promise<T>) => Promise<T>): Promise<T> {
    await requireModule(this.#pool, 'service');
    const c = await this.#pool.connect();
    try {
      await c.query('BEGIN');
      const v = await this.#vehicles.access(c, p, vehicleId, true);
      const visit = await this.#visit(c, v, visitId, true);
      if (!canChangeVisit(v.role, visit.created_by, p.userId)) throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Your role does not allow changing attachments on this service visit.');
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived. Unarchive it to change its records.');
      // The change and its audit row are one unit: an idempotent replay (wrap) returns the first outcome and writes neither.
      const run = async (): Promise<T> => {
        const r = await fn(c, visit.id, v);
        await auditAs(c, p, { action, subjectType: 'vehicle', subjectId: v.id, details: { visitId: visit.id, attachmentId: r.attachmentId, ...r.extra }, target: { type: 'service_attachment', ids: [r.attachmentId] } });
        return r.out;
      };
      const out = wrap ? await wrap(c, v, visit.id, run) : await run();
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  /**
   * `idem` (an API key's Idempotency-Key): the same key and file again returns the first outcome without writing.
   * For an API key a file already on the visit (same sha256) is refused (409 attachment_duplicate) instead of stored twice; sessions are unchanged.
   */
  async add(p: Principal, vehicleId: unknown, visitId: unknown, body: RawBody, fileName: string | null, idem?: Idem): Promise<AttachmentView> {
    if (!body.data.length) throw new HttpProblem(422, 'validation_failed', 'Validation failed', 'The file is empty.');
    const type = sniffAttachment(body.data);
    if (!type) throw new HttpProblem(422, 'attachment_type', 'Validation failed', 'The file is not a PDF, JPEG or PNG file.');
    if (body.type !== 'application/octet-stream' && body.type !== type) throw new HttpProblem(422, 'attachment_type', 'Validation failed', 'The file content does not match its declared type.');
    const f: ParsedAttachment = { fileName: sanitiseFileName(fileName) ?? defaultFileName(type), contentType: type, sha256: createHash('sha256').update(body.data).digest('hex'), data: body.data };
    return this.#write(p, vehicleId, visitId, 'service_attachment.add', async (c, visit) => {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM service_attachments WHERE visit_id = $1', [visit])).rows[0]!.n;
      if (n >= MAX_ATTACHMENTS_PER_VISIT) throw tooMany();
      if (p.kind === 'api_key') {
        const same = (await c.query<{ id: Id }>('SELECT id FROM service_attachments WHERE visit_id = $1 AND sha256 = $2 LIMIT 1', [visit, f.sha256])).rows[0];
        if (same) throw new HttpProblem(409, 'attachment_duplicate', 'Conflict', 'This file is already attached to the service visit.', { attachmentId: same.id });
      }
      const row = await insert(c, visit, f, p.userId);
      return { out: toView(row), attachmentId: row.id, extra: { contentType: type, sizeBytes: f.data.length } };
    }, (c, v, visit, run) => withIdempotency(c, p, idem, { operation: 'service_attachment.add', target: `${v.id}/${visit}`, payload: { sha256: f.sha256, fileName: f.fileName }, now: this.#now() }, run));
  }

  async rename(p: Principal, vehicleId: unknown, visitId: unknown, attachmentId: unknown, body: unknown): Promise<AttachmentView> {
    const b = obj(body, ['fileName']);
    const name = sanitiseFileName(b['fileName']);
    if (!name) throw invalid('fileName must contain a file name.');
    return this.#write(p, vehicleId, visitId, 'service_attachment.rename', async (c, visit) => {
      if (!isUuid(attachmentId)) throw notFound();
      const r = (await c.query<MetaRow>(`UPDATE service_attachments SET file_name = $3 WHERE id = $1 AND visit_id = $2 RETURNING ${META}`, [attachmentId, visit, name])).rows[0];
      if (!r) throw notFound();
      return { out: toView(r), attachmentId: r.id };
    });
  }

  async remove(p: Principal, vehicleId: unknown, visitId: unknown, attachmentId: unknown): Promise<void> {
    await this.#write(p, vehicleId, visitId, 'service_attachment.delete', async (c, visit) => {
      if (!isUuid(attachmentId)) throw notFound();
      const n = (await c.query('DELETE FROM service_attachments WHERE id = $1 AND visit_id = $2', [attachmentId, visit])).rowCount;
      if (!n) throw notFound();
      return { out: undefined, attachmentId };
    });
  }

  /** Any member may read. Non-members get the same 404 as for any vehicle. */
  async download(p: Principal, vehicleId: unknown, visitId: unknown, attachmentId: unknown): Promise<{ fileName: string; contentType: AttachmentType; data: Buffer }> {
    await requireModule(this.#pool, 'service');
    const v = await this.#vehicles.access(this.#pool, p, vehicleId);
    await this.#visit(this.#pool, v, visitId);
    if (!isUuid(attachmentId)) throw notFound();
    const r = (await this.#pool.query<{ file_name: string; content_type: AttachmentType; data: Buffer }>(
      'SELECT file_name, content_type, data FROM service_attachments WHERE id = $1 AND visit_id = $2', [attachmentId, visitId])).rows[0];
    if (!r) throw notFound();
    return { fileName: r.file_name, contentType: r.content_type, data: r.data };
  }
}

export function attachmentRoutes(svc: AttachmentService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const base = '/v1/vehicles/:vehicleId/service-visits/:visitId/attachments';
  const one = `${base}/:attachmentId`;
  return [
    { method: 'POST', path: base, rawBody: { types: [...ATTACHMENT_TYPES, 'application/octet-stream'], maxBytes: MAX_ATTACHMENT_BYTES }, async handler(r) {
      const idem = idemFrom(r.headers, who(r));
      const body = await svc.add(who(r), r.params['vehicleId'], r.params['visitId'], r.body as RawBody, r.query.get('fileName'), idem);
      return { status: idem.status ?? 201, body, headers: idemHeaders(idem) };
    } },
    { method: 'GET', path: one, async handler(r) {
      const a = await svc.download(who(r), r.params['vehicleId'], r.params['visitId'], r.params['attachmentId']);
      const inline = r.query.get('inline') === '1';
      return {
        status: 200, raw: { data: a.data, contentType: a.contentType },
        // Receipts are private: never cached, never rendered with scripts or sniffed.
        headers: { 'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', a.fileName), 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' },
      };
    } },
    { method: 'PATCH', path: one, async handler(r) { return { status: 200, body: await svc.rename(who(r), r.params['vehicleId'], r.params['visitId'], r.params['attachmentId'], r.body) }; } },
    { method: 'DELETE', path: one, async handler(r) { await svc.remove(who(r), r.params['vehicleId'], r.params['visitId'], r.params['attachmentId']); return { status: 204 }; } },
  ];
}
