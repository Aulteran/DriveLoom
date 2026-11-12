// Accounts, password sign-in, second factor, recovery and credential management.
import type { PoolClient } from 'pg';
import { withTx, type Tx } from '../db.ts';
import { HttpProblem } from '../http/problem.ts';
import { uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import type { Principal } from '../identity.ts';
import { audit, checkPassword, normaliseEmail, problem, rateLimit, type AuthContext } from './context.ts';
import {
  base32, decryptSecret, dummyHash, encryptSecret, hashPassword, hmacHex, matchTotp, numericCode, randomToken, recoveryCode, safeEqual, sha256Hex, verifyPassword,
} from './crypto.ts';
import { createSession, requireFresh, revokeAll, touchReauth, type NewSession } from './sessions.ts';

const BOOTSTRAP_LOCK = 7_165_202;
const TEN_MIN = 10 * 60_000, HOUR = 3_600_000;
type Meta = { ip: string; userAgent: string };

interface UserRow { id: Id; email: string; instance_role: 'admin' | 'user'; status: string; email_verified_at: Date | null; display_name: string }

async function findUser(q: Pick<PoolClient, 'query'>, email: string): Promise<UserRow | undefined> {
  const { rows } = await q.query<UserRow>("SELECT id, email, instance_role, status, email_verified_at, display_name FROM users WHERE email = $1 AND status <> 'deleted'", [email]);
  return rows[0];
}

// ---------- one-time emailed codes ----------
async function issueCode(ctx: AuthContext, tx: Pick<PoolClient, 'query'>, userId: Id, purpose: CodePurpose): Promise<string> {
  const code = numericCode(8);
  const now = ctx.now();
  await tx.query("UPDATE one_time_codes SET consumed_at = $3 WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL", [userId, purpose, now]);
  await tx.query('INSERT INTO one_time_codes (id, user_id, purpose, code_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuidv7(), userId, purpose, hmacHex(ctx.config.secretKey, purpose, code), now, new Date(now.getTime() + ctx.config.codeTtlMs)]);
  return code;
}

/** Counts the attempt first (atomically), then checks; a code is single-use and dies after too many attempts. */
async function consumeCode(ctx: AuthContext, userId: Id, purpose: CodePurpose, code: unknown): Promise<void> {
  const now = ctx.now();
  const { rows } = await ctx.db.query<{ id: Id; code_hash: string }>(
    `UPDATE one_time_codes SET attempts = attempts + 1 WHERE id = (
       SELECT id FROM one_time_codes WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > $3 AND attempts < $4
       ORDER BY created_at DESC LIMIT 1) RETURNING id, code_hash`,
    [userId, purpose, now, ctx.config.maxCodeAttempts]);
  const row = rows[0];
  if (!row || typeof code !== 'string' || !safeEqual(hmacHex(ctx.config.secretKey, purpose, code.trim()), row.code_hash)) throw problem.invalidCode();
  const r = await ctx.db.query('UPDATE one_time_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL', [row.id, now]);
  if (!r.rowCount) throw problem.invalidCode();
}

// ---------- registration ----------
export type RegisterResult = { status: 'created' } | { status: 'verification_sent' };

export async function register(ctx: AuthContext, input: { email: unknown; password: unknown; displayName?: unknown; setupToken?: unknown; inviteToken?: unknown }, meta: Meta): Promise<RegisterResult> {
  const email = normaliseEmail(input.email);
  const password = checkPassword(ctx, input.password);
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 80) : '';
  await rateLimit(ctx, `register:ip:${meta.ip}`, 10, HOUR);
  const hash = await hashPassword(password); // hashed before any lookup so timing does not reveal existing accounts
  const verify = !!ctx.mailer && ctx.config.requireEmailVerification;
  return withTx(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
    const first = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]!.n === 0;
    // Closed registration still admits the holder of an unused, unexpired invitation.
    let inviteId: Id | null = null;
    if (!first && ctx.config.registration !== 'open') {
      const invite = typeof input.inviteToken === 'string' && input.inviteToken
        ? (await tx.query<{ id: Id; email: string | null }>(
          'SELECT id, email FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE', [sha256Hex(input.inviteToken), ctx.now()])).rows[0]
        : undefined;
      if (!invite || (invite.email !== null && invite.email !== email)) throw new HttpProblem(403, 'registration_closed', 'Registration is closed on this instance');
      inviteId = invite.id;
    }
    // Bootstrap: the first account becomes the administrator. An operator who
    // exposes the instance before registering can require a setup token.
    if (first && ctx.config.setupToken !== null && (typeof input.setupToken !== 'string' || !safeEqual(sha256Hex(input.setupToken), sha256Hex(ctx.config.setupToken)))) {
      throw new HttpProblem(403, 'setup_token_required', 'A valid setup token is required to create the first account');
    }
    const existing = await findUser(tx, email);
    if (existing) {
      if (!verify) throw new HttpProblem(409, 'email_taken', 'An account with this email already exists');
      await ctx.mailer!.send(email, 'DriveLoom registration', 'Someone tried to register this email address, but an account already exists. If this was you, sign in or use account recovery. Otherwise ignore this message.').catch(() => undefined);
      return { status: 'verification_sent' as const };
    }
    const id = uuidv7();
    await tx.query('INSERT INTO users (id, email, display_name, instance_role, created_at) VALUES ($1,$2,$3,$4,$5)', [id, email, displayName, first ? 'admin' : 'user', ctx.now()]);
    await tx.query('INSERT INTO password_credentials (user_id, hash, updated_at) VALUES ($1,$2,$3)', [id, hash, ctx.now()]);
    await audit(tx, id, 'account.registered', id, { bootstrap_admin: first, invited: inviteId !== null }, ctx.now());
    if (inviteId) await tx.query('UPDATE invites SET used_at = $2, used_by = $3 WHERE id = $1', [inviteId, ctx.now(), id]);
    if (verify) {
      const code = await issueCode(ctx, tx, id, 'verify_email');
      try { await ctx.mailer!.send(email, 'Verify your DriveLoom email', `Your verification code is ${code}. It expires in ${Math.round(ctx.config.codeTtlMs / 60000)} minutes.`); }
      catch { throw new HttpProblem(503, 'email_unavailable', 'Could not send the verification email; try again later'); }
      return { status: 'verification_sent' as const };
    }
    return { status: 'created' as const };
  });
}

export async function verifyEmail(ctx: AuthContext, input: { email: unknown; code: unknown }, meta: Meta): Promise<void> {
  const email = normaliseEmail(input.email);
  await rateLimit(ctx, `code:ip:${meta.ip}`, 30, TEN_MIN);
  await rateLimit(ctx, `code:acct:${email}`, 10, TEN_MIN);
  const u = await findUser(ctx.db, email);
  if (!u) throw problem.invalidCode();
  await consumeCode(ctx, u.id, 'verify_email', input.code);
  await ctx.db.query('UPDATE users SET email_verified_at = $2 WHERE id = $1 AND email_verified_at IS NULL', [u.id, ctx.now()]);
  await audit(ctx.db, u.id, 'account.email_verified', u.id, {}, ctx.now());
}

// ---------- sign-in ----------
type CodePurpose = 'verify_email' | 'recover_account' | 'sign_in';

/** `mfaMethod` names the second step a pending session must complete. */
export interface SignIn { session: NewSession; userId: Id; mfaRequired: boolean; mfaMethod?: 'totp' | 'email' }

export async function login(ctx: AuthContext, input: { email: unknown; password: unknown }, meta: Meta): Promise<SignIn> {
  const email = normaliseEmail(input.email);
  if (typeof input.password !== 'string' || input.password.length > 256) throw problem.invalidCredentials();
  await rateLimit(ctx, `login:ip:${meta.ip}`, 30, TEN_MIN);
  await rateLimit(ctx, `login:acct:${email}`, 10, TEN_MIN);
  if (!ctx.config.passwordEnabled) throw new HttpProblem(403, 'password_login_disabled', 'Password sign-in is disabled on this instance');
  const u = await findUser(ctx.db, email);
  const cred = u ? (await ctx.db.query<{ hash: string }>('SELECT hash FROM password_credentials WHERE user_id = $1', [u.id])).rows[0] : undefined;
  const ok = await verifyPassword(input.password, cred?.hash ?? (await dummyHash()));
  if (!u || !cred || !ok || u.status !== 'active') {
    await audit(ctx.db, null, 'login.failed', u?.id ?? null, { method: 'password' }, ctx.now());
    throw problem.invalidCredentials();
  }
  // Reveal the unverified state only to someone who proved the password.
  if (ctx.mailer && ctx.config.requireEmailVerification && !u.email_verified_at) throw new HttpProblem(403, 'email_not_verified', 'Verify your email address before signing in');
  const totp = await ctx.db.query('SELECT 1 FROM totp_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL', [u.id]);
  // An authenticator app wins; otherwise the instance may require an emailed code.
  const mfaMethod = totp.rowCount ? 'totp' as const : ctx.config.emailSignInCodes && ctx.mailer ? 'email' as const : undefined;
  if (mfaMethod === 'email') {
    const code = await issueCode(ctx, ctx.db, u.id, 'sign_in');
    try { await ctx.mailer!.send(u.email, 'Your DriveLoom sign-in code', `Your sign-in code is ${code}. It expires in ${Math.round(ctx.config.codeTtlMs / 60000)} minutes. If you did not just sign in, change your password.`); }
    catch { throw new HttpProblem(503, 'email_unavailable', 'Could not send the sign-in code; try again later'); }
  }
  const mfaRequired = !!mfaMethod;
  const session = await createSession(ctx, u.id, mfaRequired ? 'pending' : 'active', meta);
  await audit(ctx.db, u.id, mfaRequired ? 'login.first_factor' : 'login.succeeded', u.id, { method: 'password' }, ctx.now());
  return { session, userId: u.id, mfaRequired, ...(mfaMethod ? { mfaMethod } : {}) };
}

/** Second factor for a pending session. The pending session is destroyed and a fresh one issued (no fixation). */
export async function completeMfa(ctx: AuthContext, pending: { sessionId: Id; userId: Id }, input: { code?: unknown; recoveryCode?: unknown }, meta: Meta): Promise<SignIn> {
  await rateLimit(ctx, `mfa:acct:${pending.userId}`, 10, TEN_MIN);
  await rateLimit(ctx, `mfa:ip:${meta.ip}`, 30, TEN_MIN);
  const ok = typeof input.recoveryCode === 'string' && input.recoveryCode
    ? await useRecoveryCode(ctx, pending.userId, input.recoveryCode)
    : await checkTotp(ctx, pending.userId, input.code);
  if (!ok) {
    await audit(ctx.db, pending.userId, 'login.mfa_failed', pending.userId, {}, ctx.now());
    throw new HttpProblem(401, 'invalid_code', 'Code is invalid or expired');
  }
  await ctx.db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [pending.sessionId, ctx.now()]);
  const session = await createSession(ctx, pending.userId, 'active', meta);
  await audit(ctx.db, pending.userId, 'login.succeeded', pending.userId, { method: 'password+totp' }, ctx.now());
  return { session, userId: pending.userId, mfaRequired: false };
}

/** Second step by emailed code, for accounts without an authenticator app. */
export async function completeEmailMfa(ctx: AuthContext, pending: { sessionId: Id; userId: Id }, input: { code?: unknown }, meta: Meta): Promise<SignIn> {
  await rateLimit(ctx, `mfa:acct:${pending.userId}`, 10, TEN_MIN);
  await rateLimit(ctx, `mfa:ip:${meta.ip}`, 30, TEN_MIN);
  // An account that has since enrolled an authenticator app must use it.
  const totp = await ctx.db.query('SELECT 1 FROM totp_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL', [pending.userId]);
  if (totp.rowCount) throw new HttpProblem(401, 'invalid_code', 'Code is invalid or expired');
  try { await consumeCode(ctx, pending.userId, 'sign_in', input.code); } catch (e) {
    await audit(ctx.db, pending.userId, 'login.mfa_failed', pending.userId, { method: 'email' }, ctx.now());
    throw e;
  }
  await ctx.db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [pending.sessionId, ctx.now()]);
  const session = await createSession(ctx, pending.userId, 'active', meta);
  await audit(ctx.db, pending.userId, 'login.succeeded', pending.userId, { method: 'password+email' }, ctx.now());
  return { session, userId: pending.userId, mfaRequired: false };
}

async function checkTotp(ctx: AuthContext, userId: Id, code: unknown): Promise<boolean> {
  if (typeof code !== 'string') return false;
  const { rows } = await ctx.db.query<{ secret_enc: string }>('SELECT secret_enc FROM totp_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL', [userId]);
  if (!rows[0]) return false;
  const step = matchTotp(decryptSecret(ctx.config.secretKey, rows[0].secret_enc), code.trim(), ctx.now().getTime());
  if (step === null) return false;
  // Replay protection: only a step newer than the last accepted one wins, atomically.
  const r = await ctx.db.query('UPDATE totp_credentials SET last_step = $2 WHERE user_id = $1 AND last_step < $2', [userId, step]);
  return !!r.rowCount;
}

async function useRecoveryCode(ctx: AuthContext, userId: Id, code: string): Promise<boolean> {
  const h = hmacHex(ctx.config.secretKey, 'recovery', code.trim().toLowerCase());
  const r = await ctx.db.query('UPDATE recovery_codes SET used_at = $3 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [userId, h, ctx.now()]);
  if (r.rowCount) await audit(ctx.db, userId, 'login.recovery_code_used', userId, {}, ctx.now());
  return !!r.rowCount;
}

/** Refresh the session's authentication time (for sensitive actions) with password or TOTP. */
export async function reauthenticate(ctx: AuthContext, p: Principal, input: { password?: unknown; code?: unknown }, meta: Meta): Promise<void> {
  await rateLimit(ctx, `reauth:acct:${p.userId}`, 10, TEN_MIN);
  let ok = false;
  if (typeof input.password === 'string') {
    const cred = (await ctx.db.query<{ hash: string }>('SELECT hash FROM password_credentials WHERE user_id = $1', [p.userId])).rows[0];
    ok = await verifyPassword(input.password, cred?.hash ?? (await dummyHash())) && !!cred;
  } else if (typeof input.code === 'string') {
    ok = await checkTotp(ctx, p.userId, input.code);
  }
  if (!ok) throw new HttpProblem(401, 'invalid_credentials', 'Invalid credentials');
  await touchReauth(ctx, p.sessionId);
  void meta;
}

// ---------- password ----------
export async function setPassword(ctx: AuthContext, p: Principal, input: { currentPassword?: unknown; newPassword: unknown }): Promise<void> {
  const next = checkPassword(ctx, input.newPassword);
  await rateLimit(ctx, `pwchange:acct:${p.userId}`, 10, TEN_MIN);
  const cred = (await ctx.db.query<{ hash: string }>('SELECT hash FROM password_credentials WHERE user_id = $1', [p.userId])).rows[0];
  if (cred) {
    if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, cred.hash))) throw new HttpProblem(401, 'invalid_credentials', 'Current password is incorrect');
  } else {
    requireFresh(ctx, p); // adding a first password to an OIDC/passkey account needs recent sign-in
  }
  const hash = await hashPassword(next);
  await ctx.db.query('INSERT INTO password_credentials (user_id, hash, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET hash = $2, updated_at = $3', [p.userId, hash, ctx.now()]);
  await audit(ctx.db, p.userId, cred ? 'credential.password_changed' : 'credential.password_added', p.userId, {}, ctx.now());
  await revokeAll(ctx, p.userId, p.sessionId, 'password_changed');
}

/** How many independent primary sign-in methods the user has. */
export async function primaryMethodCount(ctx: AuthContext, q: Pick<PoolClient, 'query'>, userId: Id): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM password_credentials WHERE user_id = $1 AND $2::boolean)
           + (SELECT count(*) FROM passkeys WHERE user_id = $1)
           + (SELECT count(*) FROM oidc_identities WHERE user_id = $1))::int AS n`, [userId, ctx.config.passwordEnabled]);
  return rows[0]!.n;
}

/** Run a credential removal so the user can never be left with no primary sign-in method. */
export async function removeGuarded(ctx: AuthContext, p: Principal, remove: (tx: Tx) => Promise<number>, action: string, details: Record<string, unknown>): Promise<void> {
  requireFresh(ctx, p);
  await withTx(ctx.db, async (tx) => {
    await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [p.userId]); // serialise concurrent removals
    const removed = await remove(tx);
    if (!removed) throw new HttpProblem(404, 'not_found', 'Credential not found');
    if ((await primaryMethodCount(ctx, tx, p.userId)) < 1) throw new HttpProblem(409, 'last_credential', 'This is your only sign-in method; add another before removing it');
    await audit(tx, p.userId, action, p.userId, details, ctx.now());
  });
  await revokeAll(ctx, p.userId, p.sessionId, action);
}

export const removePassword = (ctx: AuthContext, p: Principal) =>
  removeGuarded(ctx, p, async (tx) => (await tx.query('DELETE FROM password_credentials WHERE user_id = $1', [p.userId])).rowCount ?? 0, 'credential.password_removed', {});

// ---------- recovery by email ----------
/**
 * Validation and rate limits run inline. The account lookup, code issue and
 * SMTP round trip happen in the returned `delivery` promise: the HTTP route
 * answers without waiting for it, so response time cannot reveal whether the
 * address has an account. Direct callers (tests, CLI) may await `delivery`.
 */
export async function recoveryRequest(ctx: AuthContext, input: { email: unknown }, meta: Meta): Promise<{ delivery: Promise<void> }> {
  if (!ctx.mailer) throw new HttpProblem(501, 'email_not_configured', 'Email recovery is not available on this instance; ask an administrator');
  const mailer = ctx.mailer;
  const email = normaliseEmail(input.email);
  await rateLimit(ctx, `recover:ip:${meta.ip}`, 20, HOUR);
  await rateLimit(ctx, `recover:acct:${email}`, 5, HOUR);
  const delivery = (async () => {
    const u = await findUser(ctx.db, email);
    if (!u || u.status !== 'active') return;
    const code = await issueCode(ctx, ctx.db, u.id, 'recover_account');
    await audit(ctx.db, u.id, 'recovery.requested', u.id, {}, ctx.now());
    await mailer.send(email, 'DriveLoom account recovery', `Your recovery code is ${code}. It expires in ${Math.round(ctx.config.codeTtlMs / 60000)} minutes. If you did not request this, ignore this message.`);
  })().catch((err) => { console.error('recovery email was not delivered:', err instanceof Error ? err.message : err); });
  return { delivery };
}

export async function recoveryComplete(ctx: AuthContext, input: { email: unknown; code: unknown; newPassword: unknown }, meta: Meta): Promise<void> {
  const email = normaliseEmail(input.email);
  const next = checkPassword(ctx, input.newPassword);
  await rateLimit(ctx, `code:ip:${meta.ip}`, 30, TEN_MIN);
  await rateLimit(ctx, `code:acct:${email}`, 10, TEN_MIN);
  const u = await findUser(ctx.db, email);
  if (!u || u.status !== 'active') throw problem.invalidCode();
  await consumeCode(ctx, u.id, 'recover_account', input.code);
  const hash = await hashPassword(next);
  await ctx.db.query('INSERT INTO password_credentials (user_id, hash, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET hash = $2, updated_at = $3', [u.id, hash, ctx.now()]);
  await ctx.db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1', [u.id, ctx.now()]);
  await revokeAll(ctx, u.id, null, 'account_recovery');
  await audit(ctx.db, u.id, 'recovery.completed', u.id, {}, ctx.now());
}

/** Operator recovery (CLI): set a new password without email. Always audited, revokes every session. */
export async function adminResetPassword(ctx: AuthContext, emailRaw: string, newPassword: string): Promise<void> {
  const email = normaliseEmail(emailRaw);
  const next = checkPassword(ctx, newPassword);
  const u = await findUser(ctx.db, email);
  if (!u) throw new HttpProblem(404, 'not_found', 'No such account');
  const hash = await hashPassword(next);
  await ctx.db.query('INSERT INTO password_credentials (user_id, hash, updated_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET hash = $2, updated_at = $3', [u.id, hash, ctx.now()]);
  await revokeAll(ctx, u.id, null, 'operator_recovery');
  await audit(ctx.db, null, 'recovery.operator_password_reset', u.id, {}, ctx.now());
}

// ---------- TOTP ----------
export async function totpBegin(ctx: AuthContext, p: Principal): Promise<{ secret: string; otpauthUri: string }> {
  requireFresh(ctx, p);
  const existing = await ctx.db.query('SELECT 1 FROM totp_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL', [p.userId]);
  if (existing.rowCount) throw new HttpProblem(409, 'totp_exists', 'An authenticator is already enrolled; remove it first');
  const secret = Buffer.from(randomToken(20), 'base64url').subarray(0, 20);
  await ctx.db.query(
    `INSERT INTO totp_credentials (user_id, secret_enc, created_at) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = $2, confirmed_at = NULL, last_step = 0, created_at = $3`,
    [p.userId, encryptSecret(ctx.config.secretKey, secret), ctx.now()]);
  const email = (await ctx.db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.userId])).rows[0]!.email;
  const b32 = base32(secret);
  return { secret: b32, otpauthUri: `otpauth://totp/DriveLoom:${encodeURIComponent(email)}?secret=${b32}&issuer=DriveLoom&algorithm=SHA1&digits=6&period=30` };
}

export async function totpConfirm(ctx: AuthContext, p: Principal, code: unknown): Promise<{ recoveryCodes: string[] }> {
  requireFresh(ctx, p);
  await rateLimit(ctx, `mfa:acct:${p.userId}`, 10, TEN_MIN);
  const { rows } = await ctx.db.query<{ secret_enc: string }>('SELECT secret_enc FROM totp_credentials WHERE user_id = $1 AND confirmed_at IS NULL', [p.userId]);
  if (!rows[0] || typeof code !== 'string') throw problem.invalidCode();
  const step = matchTotp(decryptSecret(ctx.config.secretKey, rows[0].secret_enc), code.trim(), ctx.now().getTime());
  if (step === null) throw problem.invalidCode();
  const codes = Array.from({ length: 10 }, () => recoveryCode());
  await withTx(ctx.db, async (tx) => {
    await tx.query('UPDATE totp_credentials SET confirmed_at = $2, last_step = $3 WHERE user_id = $1', [p.userId, ctx.now(), step]);
    await tx.query('DELETE FROM recovery_codes WHERE user_id = $1', [p.userId]);
    for (const c of codes) await tx.query('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1,$2,$3)', [uuidv7(), p.userId, hmacHex(ctx.config.secretKey, 'recovery', c)]);
    await audit(tx, p.userId, 'credential.totp_added', p.userId, {}, ctx.now());
  });
  return { recoveryCodes: codes };
}

export async function totpRemove(ctx: AuthContext, p: Principal): Promise<void> {
  requireFresh(ctx, p);
  await withTx(ctx.db, async (tx) => {
    const r = await tx.query('DELETE FROM totp_credentials WHERE user_id = $1', [p.userId]);
    if (!r.rowCount) throw new HttpProblem(404, 'not_found', 'No authenticator enrolled');
    await tx.query('DELETE FROM recovery_codes WHERE user_id = $1', [p.userId]);
    await audit(tx, p.userId, 'credential.totp_removed', p.userId, {}, ctx.now());
  });
  await revokeAll(ctx, p.userId, p.sessionId, 'totp_removed');
}

// ---------- overview ----------
export async function describeAccount(ctx: AuthContext, p: Principal) {
  const q = ctx.db;
  const [u, pw, totp, rc, pk, oidc] = await Promise.all([
    q.query<UserRow>('SELECT id, email, instance_role, status, email_verified_at, display_name FROM users WHERE id = $1', [p.userId]),
    q.query('SELECT 1 FROM password_credentials WHERE user_id = $1', [p.userId]),
    q.query('SELECT 1 FROM totp_credentials WHERE user_id = $1 AND confirmed_at IS NOT NULL', [p.userId]),
    q.query('SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [p.userId]),
    q.query<{ id: Id; label: string; created_at: Date; last_used_at: Date | null }>('SELECT id, label, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at', [p.userId]),
    q.query<{ id: Id; issuer: string; email: string | null }>('SELECT id, issuer, email FROM oidc_identities WHERE user_id = $1 ORDER BY created_at', [p.userId]),
  ]);
  const user = u.rows[0]!;
  return {
    id: user.id, email: user.email, displayName: user.display_name, instanceRole: user.instance_role, emailVerified: !!user.email_verified_at,
    credentials: {
      password: !!pw.rowCount, totp: !!totp.rowCount, recoveryCodesRemaining: rc.rows[0]!.n,
      passkeys: pk.rows, oidc: oidc.rows,
    },
  };
}

// ---------- profile and account removal ----------
export async function updateProfile(ctx: AuthContext, p: Principal, input: { displayName?: unknown }): Promise<void> {
  if (typeof input.displayName !== 'string' || input.displayName.trim().length > 80) throw problem.invalidInput('display_name must be text of at most 80 characters');
  await ctx.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [p.userId, input.displayName.trim()]);
}

/**
 * Remove the caller's own account. Refused while they own a vehicle (transfer
 * it first, or ask an administrator to recover it) and for the last active
 * administrator. Credentials, sessions, memberships, friendships and
 * preferences are deleted; the user row stays as an anonymised tombstone so
 * audit history and records they entered on shared vehicles keep a referent.
 */
export async function deleteAccount(ctx: AuthContext, p: Principal): Promise<void> {
  requireFresh(ctx, p);
  await withTx(ctx.db, async (tx) => {
    const u = (await tx.query<{ instance_role: string }>('SELECT instance_role FROM users WHERE id = $1 FOR UPDATE', [p.userId])).rows[0]!;
    const owned = await tx.query<{ vehicle_id: Id }>("SELECT vehicle_id FROM vehicle_members WHERE user_id = $1 AND role = 'owner' ORDER BY vehicle_id", [p.userId]);
    if (owned.rowCount) throw new HttpProblem(409, 'owns_vehicles', 'Transfer ownership of your vehicles before deleting your account', undefined, { vehicleIds: owned.rows.map((r) => r.vehicle_id) });
    if (u.instance_role === 'admin') {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
      const others = await tx.query("SELECT 1 FROM users WHERE instance_role = 'admin' AND status = 'active' AND id <> $1 LIMIT 1", [p.userId]);
      if (!others.rowCount) throw new HttpProblem(409, 'last_admin', 'The last administrator cannot be removed; promote another user first');
    }
    for (const t of ['vehicle_members', 'user_preferences', 'password_credentials', 'totp_credentials', 'recovery_codes', 'passkeys', 'oidc_identities', 'one_time_codes', 'auth_challenges']) {
      await tx.query(`DELETE FROM ${t} WHERE user_id = $1`, [p.userId]);
    }
    await tx.query('DELETE FROM friendships WHERE requester_id = $1 OR addressee_id = $1', [p.userId]);
    await tx.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [p.userId, ctx.now()]);
    await tx.query("UPDATE users SET status = 'deleted', email = $2, display_name = '', email_verified_at = NULL WHERE id = $1", [p.userId, `deleted-${p.userId}@deleted.invalid`]);
    await audit(tx, p.userId, 'account.deleted', p.userId, {}, ctx.now());
  });
}
