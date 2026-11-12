// WebAuthn passkeys on @simplewebauthn/server. Challenges live in the database
// and are consumed atomically, so a ceremony can be completed at most once.
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { HttpProblem } from '../http/problem.ts';
import { uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import type { Principal } from '../identity.ts';
import { audit, problem, rateLimit, type AuthContext } from './context.ts';
import { createSession, requireFresh } from './sessions.ts';
import { removeGuarded, type SignIn } from './accounts.ts';

const CHALLENGE_TTL = 5 * 60_000, TEN_MIN = 10 * 60_000;
type Meta = { ip: string; userAgent: string };

async function storeChallenge(ctx: AuthContext, kind: 'webauthn_register' | 'webauthn_login', challenge: string, userId: Id | null): Promise<void> {
  await ctx.db.query('INSERT INTO auth_challenges (id, kind, key, user_id, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [uuidv7(), kind, challenge, userId, new Date(ctx.now().getTime() + CHALLENGE_TTL)]);
}

/** Atomically consume a live challenge of this kind (and owner, if given). */
function consumer(ctx: AuthContext, kind: 'webauthn_register' | 'webauthn_login', userId: Id | null) {
  return async (challenge: string): Promise<boolean> => {
    const r = await ctx.db.query(
      `UPDATE auth_challenges SET consumed_at = $4 WHERE key = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > $4
         AND (user_id IS NOT DISTINCT FROM $3::uuid)`, [challenge, kind, userId, ctx.now()]);
    return !!r.rowCount;
  };
}

const userHandle = (id: Id) => Buffer.from(id.replace(/-/g, ''), 'hex');

export async function registerOptions(ctx: AuthContext, p: Principal) {
  requireFresh(ctx, p);
  const [{ rows: u }, { rows: existing }] = await Promise.all([
    ctx.db.query<{ email: string; display_name: string }>('SELECT email, display_name FROM users WHERE id = $1', [p.userId]),
    ctx.db.query<{ credential_id: string; transports: string[] }>('SELECT credential_id, transports FROM passkeys WHERE user_id = $1', [p.userId]),
  ]);
  const options = await generateRegistrationOptions({
    rpName: ctx.config.rpName, rpID: ctx.config.rpId, userName: u[0]!.email, userDisplayName: u[0]!.display_name || u[0]!.email,
    userID: userHandle(p.userId),
    excludeCredentials: existing.map((e) => ({ id: e.credential_id, transports: e.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await storeChallenge(ctx, 'webauthn_register', options.challenge, p.userId);
  return options;
}

export async function registerVerify(ctx: AuthContext, p: Principal, response: unknown, label: unknown): Promise<{ id: Id }> {
  requireFresh(ctx, p);
  await rateLimit(ctx, `passkey:acct:${p.userId}`, 20, TEN_MIN);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: consumer(ctx, 'webauthn_register', p.userId),
      expectedOrigin: ctx.config.publicOrigin, expectedRPID: ctx.config.rpId, requireUserVerification: true,
    });
  } catch { throw new HttpProblem(400, 'passkey_invalid', 'Passkey registration could not be verified'); }
  if (!v.verified) throw new HttpProblem(400, 'passkey_invalid', 'Passkey registration could not be verified');
  const c = v.registrationInfo.credential;
  const id = uuidv7();
  try {
    await ctx.db.query('INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, p.userId, c.id, Buffer.from(c.publicKey), c.counter, c.transports ?? [], typeof label === 'string' ? label.trim().slice(0, 60) : '', ctx.now()]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpProblem(409, 'passkey_exists', 'This passkey is already registered');
    throw err;
  }
  await audit(ctx.db, p.userId, 'credential.passkey_added', p.userId, { passkey: id }, ctx.now());
  return { id };
}

export async function loginOptions(ctx: AuthContext, meta: Meta) {
  await rateLimit(ctx, `login:ip:${meta.ip}`, 30, TEN_MIN);
  const options = await generateAuthenticationOptions({ rpID: ctx.config.rpId, userVerification: 'required' });
  await storeChallenge(ctx, 'webauthn_login', options.challenge, null);
  return options;
}

export async function loginVerify(ctx: AuthContext, response: unknown, meta: Meta): Promise<SignIn> {
  await rateLimit(ctx, `login:ip:${meta.ip}`, 30, TEN_MIN);
  const r = response as AuthenticationResponseJSON;
  const fail = () => problem.invalidCredentials();
  if (!r || typeof r.id !== 'string') throw fail();
  const { rows } = await ctx.db.query<{ id: Id; user_id: Id; public_key: Buffer; counter: string; transports: string[] }>(
    `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id
      WHERE p.credential_id = $1 AND u.status = 'active'`, [r.id]);
  const pk = rows[0];
  if (!pk) throw fail();
  const handle = r.response?.userHandle;
  if (handle && handle !== userHandle(pk.user_id).toString('base64url')) throw fail();
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: r, expectedChallenge: consumer(ctx, 'webauthn_login', null),
      expectedOrigin: ctx.config.publicOrigin, expectedRPID: ctx.config.rpId, requireUserVerification: true,
      credential: { id: r.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports },
    });
  } catch { await audit(ctx.db, null, 'login.failed', pk.user_id, { method: 'passkey' }, ctx.now()); throw fail(); }
  if (!v.verified) throw fail();
  const upd = await ctx.db.query('UPDATE passkeys SET counter = $2, last_used_at = $3 WHERE id = $1 AND counter <= $2', [pk.id, v.authenticationInfo.newCounter, ctx.now()]);
  if (!upd.rowCount) throw fail();
  const session = await createSession(ctx, pk.user_id, 'active', meta);
  await audit(ctx.db, pk.user_id, 'login.succeeded', pk.user_id, { method: 'passkey' }, ctx.now());
  return { session, userId: pk.user_id, mfaRequired: false };
}

export const remove = (ctx: AuthContext, p: Principal, id: Id) =>
  removeGuarded(ctx, p, async (tx) => (await tx.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [id, p.userId])).rowCount ?? 0, 'credential.passkey_removed', { passkey: id });
