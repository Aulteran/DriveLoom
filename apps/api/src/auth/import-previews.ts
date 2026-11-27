// Preview binding for bulk writes made with an API key. A dry run of an import returns a token; the commit must present
// the token of a preview made by the SAME key, for the SAME target (a vehicle, or "a new vehicle") and for the SAME
// canonical payload digest, within 15 minutes. The token is single use and is consumed inside the commit's own
// transaction, so a commit that fails and rolls back leaves the preview valid, and a second commit cannot reuse it.
// Only a hash of the token is stored; the rows vanish with the key and are not part of backups.
import { randomToken, sha256Hex } from './crypto.ts';
import type pg from 'pg';
import { HttpProblem } from '../http/problem.ts';
import { uuidv7 } from '../ids.ts';
import type { ApiKeyPrincipal, Principal } from '../identity.ts';

export const PREVIEW_TTL_MS = 15 * 60_000;
const TOKEN_RE = /^dlp_[A-Za-z0-9_-]{32}$/;

const problems = {
  required: () => new HttpProblem(409, 'preview_required', 'Conflict', 'An API key must commit an import with the previewToken of a dry run of the same payload. Run the import with dryRun true first.'),
  mismatch: () => new HttpProblem(409, 'preview_mismatch', 'Conflict', 'The previewToken does not belong to this request: it is unknown or already used, or was issued to another key, another vehicle or a different payload. Run a new dry run.'),
  expired: () => new HttpProblem(409, 'preview_expired', 'Conflict', 'The preview has expired. Run a new dry run and commit within 15 minutes.'),
};

/** Record a preview for the key and return its token (shown once). Not part of any data transaction: a preview writes no records. */
export async function issuePreview(db: Pick<pg.Pool, 'query'>, p: ApiKeyPrincipal, target: string, digest: string, now: Date): Promise<{ token: string; expiresAt: string }> {
  const token = `dlp_${randomToken(24)}`;
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS);
  await db.query('DELETE FROM api_key_import_previews WHERE key_id = $1 AND expires_at <= $2', [p.apiKey.id, now]);
  await db.query('INSERT INTO api_key_import_previews (id, key_id, token_hash, target, payload_digest, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuidv7(), p.apiKey.id, sha256Hex(token), target, digest, now, expiresAt]);
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Inside the commit transaction: check the token against this request and consume it. Sessions need no preview. */
export async function consumePreview(c: Pick<pg.PoolClient, 'query'>, p: Principal, token: unknown, target: string, digest: string, now: Date): Promise<void> {
  if (p.kind !== 'api_key') return;
  if (token === undefined || token === null || token === '') throw problems.required();
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw problems.mismatch();
  const { rows } = await c.query<{ target: string; payload_digest: string; expires_at: Date }>(
    'DELETE FROM api_key_import_previews WHERE token_hash = $1 AND key_id = $2 RETURNING target, payload_digest, expires_at', [sha256Hex(token), p.apiKey.id]);
  const r = rows[0];
  if (!r) throw problems.mismatch();
  if (r.expires_at.getTime() <= now.getTime()) throw problems.expired();
  if (r.target !== target || r.payload_digest !== digest) throw problems.mismatch();
}
