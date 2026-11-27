// Idempotency-Key support for creates made with an API key (fill-ups, service visits, receipts, maintenance tasks
// and import commits). The record is claimed INSIDE the write's own transaction, after the vehicle row lock and the
// key re-check, so:
//   * two identical requests in flight at once are serialised by the unique index (the second blocks on the first's
//     insert, then finds its committed outcome and replays it): exactly one write happens;
//   * a retry is only replayed to a caller who still passes every check of the original request (active key, scope,
//     grants, role, module gate) because the claim comes after them;
//   * the same key with a different operation, target or payload is a 409 idempotency_conflict, never a replay;
//   * only successful outcomes are stored (a failed request rolled back and may be retried with the same key).
// The client's key is stored only as a SHA-256. Records are kept 48 hours (the spec asks for at least 24) and vanish with the key. A small response is stored whole;
// a large one is stored as a reference to the created resource and re-read on replay. Sessions ignore the header.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HttpProblem } from '../http/problem.ts';
import { uuidv7 } from '../ids.ts';
import type { Principal } from '../identity.ts';

export const IDEMPOTENCY_RETENTION_MS = 48 * 3_600_000;
/** Responses up to this size are stored as they are. */
const INLINE_LIMIT = 16 * 1024;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Per-request state shared between the route and the service: the validated header, and what happened. */
export interface Idem { readonly key: string | null; replayed: boolean; status: number | null }

/** Read the Idempotency-Key header: absent is null; present must be 1 to 255 printable characters without spaces. Only API keys use it: for a session the header is not even looked at. */
export function idemFrom(headers: { [k: string]: string | string[] | undefined }, p: Principal): Idem {
  const raw = p.kind === 'api_key' ? headers['idempotency-key'] : undefined;
  if (raw === undefined) return { key: null, replayed: false, status: null };
  if (typeof raw !== 'string' || !KEY_RE.test(raw)) throw new HttpProblem(422, 'validation_failed', 'Validation failed', 'Idempotency-Key must be 1 to 255 printable characters without spaces, sent once.');
  return { key: raw, replayed: false, status: null };
}

/** `Idempotent-Replayed: true` when the outcome came from an earlier request. */
export const idemHeaders = (i: Idem): Record<string, string> => (i.replayed ? { 'idempotent-replayed': 'true' } : {});

/** Stable JSON: object keys sorted, so the same data always serialises the same way. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export const digestOf = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');

export interface IdemSpec<T> {
  /** What the request does, for example `service_visit.create`. A different operation under the same key is a conflict. */
  operation: string;
  /** The thing it acts on (vehicle id, or vehicle id and visit id). */
  target: string;
  /** What identifies the request: hashed, never stored. */
  payload: unknown;
  now: Date;
  /** Success status to store and replay (default 201). */
  status?: number;
  /** For a response too large to store: the id of the resource that was created, and how to read it again. */
  reference?: (result: T) => string | null;
  reread?: (id: string) => Promise<T>;
  /** Shrinks a large result when it has no reference (an import report). */
  shrink?: (result: T) => T;
}

/**
 * Run `produce` once per (key, Idempotency-Key). Must be called inside the write transaction `c`. Without a header, or for
 * a session, it simply runs `produce`.
 */
export async function withIdempotency<T>(c: Pick<pg.PoolClient, 'query'>, p: Principal, idem: Idem | undefined, spec: IdemSpec<T>, produce: () => Promise<T>): Promise<T> {
  if (!idem?.key || p.kind !== 'api_key') return produce();
  const keyId = p.apiKey.id;
  // Only a SHA-256 of the client's header is stored (a careless client may send a secret as its key).
  const stored = createHash('sha256').update(idem.key).digest('hex');
  const fingerprint = digestOf({ operation: spec.operation, target: spec.target, payload: spec.payload });
  // An expired record is as good as none: it is replaced.
  await c.query('DELETE FROM api_key_idempotency WHERE key_id = $1 AND expires_at <= $2', [keyId, spec.now]);
  const claim = await c.query<{ id: string }>(
    `INSERT INTO api_key_idempotency (id, key_id, idempotency_key, operation, target, request_fingerprint, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (key_id, idempotency_key) DO NOTHING RETURNING id`,
    [uuidv7(), keyId, stored, spec.operation, spec.target, fingerprint, spec.now, new Date(spec.now.getTime() + IDEMPOTENCY_RETENTION_MS)]);
  if (!claim.rowCount) {
    // Someone else's claim, committed (an uncommitted one would have made the insert wait for its outcome).
    const { rows } = await c.query<{ request_fingerprint: string; response_status: number | null; response_meta: { kind: 'inline'; body: unknown } | { kind: 'ref'; id: string } | null }>(
      'SELECT request_fingerprint, response_status, response_meta FROM api_key_idempotency WHERE key_id = $1 AND idempotency_key = $2', [keyId, stored]);
    const r = rows[0];
    if (!r || r.request_fingerprint !== fingerprint) {
      throw new HttpProblem(409, 'idempotency_conflict', 'Conflict', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
    }
    if (r.response_status === null || r.response_meta === null) throw new HttpProblem(409, 'idempotency_conflict', 'Conflict', 'A request with this Idempotency-Key is still being processed. Retry shortly.');
    idem.replayed = true; idem.status = r.response_status;
    if (r.response_meta.kind === 'inline') return r.response_meta.body as T;
    if (!spec.reread) throw new HttpProblem(409, 'idempotency_conflict', 'Conflict', 'The stored outcome of this request is no longer available. Use a new Idempotency-Key.');
    return spec.reread(r.response_meta.id);
  }
  const result = await produce();
  const status = spec.status ?? 201;
  let meta: { kind: 'inline'; body: unknown } | { kind: 'ref'; id: string };
  const whole = JSON.stringify(result);
  if (whole.length <= INLINE_LIMIT) meta = { kind: 'inline', body: result };
  else {
    const id = spec.reference && spec.reread ? spec.reference(result) : null;
    if (id) meta = { kind: 'ref', id };
    else if (spec.shrink) meta = { kind: 'inline', body: spec.shrink(result) };
    else meta = { kind: 'inline', body: result }; // no way to shrink: keep it (still bounded by the request limits)
  }
  await c.query('UPDATE api_key_idempotency SET response_status = $3, response_meta = $4 WHERE key_id = $1 AND idempotency_key = $2', [keyId, stored, status, JSON.stringify(meta)]);
  return result;
}
