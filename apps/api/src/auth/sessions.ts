import { uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import type { InstanceRole, Principal } from '../identity.ts';
import type { Authenticator, SessionInfo } from '../http/app.ts';
import { HttpProblem } from '../http/problem.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import { audit, type AuthContext } from './context.ts';

export interface NewSession { token: string; csrfToken: string; sessionId: Id; expiresAt: Date; state: 'pending' | 'active' }

export async function createSession(ctx: AuthContext, userId: Id, state: 'pending' | 'active', meta: { ip: string; userAgent: string }): Promise<NewSession> {
  const token = randomToken(32), csrf = randomToken(24), id = uuidv7();
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + (state === 'pending' ? ctx.config.pendingTtlMs : ctx.config.sessionTtlMs));
  await ctx.db.query(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, state, created_at, authenticated_at, last_seen_at, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7,$8,$9)`,
    [id, userId, sha256Hex(token), csrf, state, now, expiresAt, meta.userAgent.slice(0, 300), meta.ip]);
  return { token, csrfToken: csrf, sessionId: id, expiresAt, state };
}

export function authenticator(ctx: AuthContext): Authenticator {
  return {
    async resolveSession(token) {
      const now = ctx.now();
      const { rows } = await ctx.db.query<{ id: Id; user_id: Id; csrf_token: string; state: 'pending' | 'active'; authenticated_at: Date; last_seen_at: Date; instance_role: InstanceRole }>(
        `SELECT s.id, s.user_id, s.csrf_token, s.state, s.authenticated_at, s.last_seen_at, u.instance_role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3 AND u.status = 'active'`,
        [sha256Hex(token), now, new Date(now.getTime() - ctx.config.sessionIdleMs)]);
      const r = rows[0];
      if (!r) return null;
      if (now.getTime() - r.last_seen_at.getTime() > 60_000) await ctx.db.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [r.id, now]);
      const principal: Principal | null = r.state === 'active'
        ? { userId: r.user_id, sessionId: r.id, instanceRole: r.instance_role, authenticatedAt: r.authenticated_at }
        : null;
      return { principal, sessionId: r.id, userId: r.user_id, csrfToken: r.csrf_token, pending: r.state === 'pending' } satisfies SessionInfo;
    },
  };
}

/** Throws reauth_required unless the session completed a sign-in or reauth recently. */
export function requireFresh(ctx: AuthContext, p: Principal): void {
  if (ctx.now().getTime() - p.authenticatedAt.getTime() > ctx.config.reauthWindowMs) throw new HttpProblem(403, 'reauth_required', 'Recent authentication required');
}

export async function touchReauth(ctx: AuthContext, sessionId: Id): Promise<void> {
  await ctx.db.query('UPDATE sessions SET authenticated_at = $2 WHERE id = $1', [sessionId, ctx.now()]);
}

export async function revokeSession(ctx: AuthContext, userId: Id, sessionId: Id): Promise<boolean> {
  const r = await ctx.db.query('UPDATE sessions SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [sessionId, userId, ctx.now()]);
  if (r.rowCount) await audit(ctx.db, userId, 'session.revoked', userId, { session: sessionId }, ctx.now());
  return !!r.rowCount;
}

/** Revoke every session of a user, optionally keeping one. Returns the number revoked. */
export async function revokeAll(ctx: AuthContext, userId: Id, except: Id | null, reason: string): Promise<number> {
  const r = await ctx.db.query('UPDATE sessions SET revoked_at = $3 WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [userId, except, ctx.now()]);
  if (r.rowCount) await audit(ctx.db, userId, 'session.revoked_all', userId, { reason, count: r.rowCount }, ctx.now());
  return r.rowCount ?? 0;
}

export async function listSessions(ctx: AuthContext, userId: Id) {
  const { rows } = await ctx.db.query<{ id: Id; created_at: Date; last_seen_at: Date; user_agent: string; ip: string }>(
    `SELECT id, created_at, last_seen_at, user_agent, ip FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND state = 'active' AND expires_at > $2 ORDER BY created_at DESC`, [userId, ctx.now()]);
  return rows;
}
