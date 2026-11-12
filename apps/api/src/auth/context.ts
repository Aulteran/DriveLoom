import type { Db } from '../db.ts';
import { HttpProblem } from '../http/problem.ts';
import { uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import type { AuthConfig } from './config.ts';
import type { Mailer } from './mailer.ts';
import { sha256Hex } from './crypto.ts';

export interface OidcClaims { issuer: string; subject: string; email: string | null; emailVerified: boolean }
/** Network-facing OIDC operations, injectable so tests need no identity provider. */
export interface OidcProvider {
  authorizationUrl(a: { state: string; nonce: string; codeVerifier: string }): Promise<string>;
  /** Must verify the ID token signature, issuer, audience, expiry and `nonce`, using PKCE. */
  exchange(a: { callbackUrl: string; state: string; nonce: string; codeVerifier: string }): Promise<OidcClaims>;
}

export interface AuthContext {
  readonly db: Db;
  readonly config: AuthConfig;
  readonly mailer: Mailer | null;
  readonly oidc: OidcProvider | null;
  readonly now: () => Date;
}

export const problem = {
  invalidCredentials: () => new HttpProblem(401, 'invalid_credentials', 'Invalid email or password'),
  rateLimited: (retryAfterSec: number) => new HttpProblem(429, 'rate_limited', 'Too many attempts', undefined, {}, { 'retry-after': String(retryAfterSec) }),
  invalidInput: (detail: string) => new HttpProblem(400, 'invalid_request', 'Invalid request', detail),
  invalidCode: () => new HttpProblem(400, 'invalid_code', 'Code is invalid or expired'),
};

/** Fixed-window limiter. Keys are hashed so raw emails/IPs are not stored. */
export async function rateLimit(ctx: AuthContext, key: string, limit: number, windowMs: number): Promise<void> {
  const t = ctx.now().getTime();
  const start = new Date(Math.floor(t / windowMs) * windowMs);
  const { rows } = await ctx.db.query<{ hits: number }>(
    `INSERT INTO rate_limits (key, window_start, hits) VALUES ($1,$2,1)
     ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits`,
    [sha256Hex(key), start]);
  if (Math.random() < 0.01) await ctx.db.query('DELETE FROM rate_limits WHERE window_start < $1', [new Date(t - 24 * 3_600_000)]);
  if (rows[0]!.hits > limit) throw problem.rateLimited(Math.max(1, Math.ceil((start.getTime() + windowMs - t) / 1000)));
}

export async function audit(db: Pick<Db, 'query'>, actor: Id | null, action: string, subjectId: Id | null, details: Record<string, unknown> = {}, at: Date = new Date()): Promise<void> {
  await db.query('INSERT INTO audit_events (id, occurred_at, actor_id, action, subject_type, subject_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [uuidv7(), at, actor, action, subjectId ? 'user' : null, subjectId, details]);
}

export function normaliseEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw problem.invalidInput('email must be a string');
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw problem.invalidInput('email is not valid');
  return e;
}

export function checkPassword(ctx: AuthContext, raw: unknown): string {
  if (typeof raw !== 'string') throw problem.invalidInput('password must be a string');
  if (raw.length < ctx.config.minPasswordLength) throw problem.invalidInput(`password must be at least ${ctx.config.minPasswordLength} characters`);
  if (raw.length > 256) throw problem.invalidInput('password is too long');
  return raw;
}
