// OIDC sign-in and linking. State is server-side and single-use, bound to the
// browser by a cookie, PKCE is always used, and an identity is keyed on
// issuer + subject. An existing account is never linked by email alone: the
// owner must start a link from a signed-in session.
import * as client from 'openid-client';
import { HttpProblem } from '../http/problem.ts';
import { uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import type { Principal } from '../identity.ts';
import { audit, problem, rateLimit, type AuthContext, type OidcProvider } from './context.ts';
import type { OidcConfig } from './config.ts';
import { randomToken, safeEqual, sha256Hex } from './crypto.ts';
import { createSession, requireFresh } from './sessions.ts';
import { removeGuarded, type SignIn } from './accounts.ts';
import { withTx } from '../db.ts';

const TTL = 10 * 60_000, BOOTSTRAP_LOCK = 7_165_202;
type Meta = { ip: string; userAgent: string };

export function createOidcProvider(cfg: OidcConfig): OidcProvider {
  let conf: Promise<client.Configuration> | undefined;
  const get = () => (conf ??= client.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret).catch((e) => { conf = undefined; throw e; }));
  return {
    async authorizationUrl({ state, nonce, codeVerifier }) {
      const c = await get();
      return client.buildAuthorizationUrl(c, {
        redirect_uri: cfg.redirectUri, scope: 'openid email', state, nonce,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256',
      }).href;
    },
    async exchange({ callbackUrl, state, nonce, codeVerifier }) {
      const c = await get();
      const tokens = await client.authorizationCodeGrant(c, new URL(callbackUrl), { pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims) throw new Error('no id token');
      return { issuer: claims.iss, subject: claims.sub, email: typeof claims['email'] === 'string' ? claims['email'].toLowerCase() : null, emailVerified: claims['email_verified'] === true };
    },
  };
}

export async function start(ctx: AuthContext, input: { mode: 'login' | 'link'; principal: Principal | null; setupToken?: unknown }, meta: Meta): Promise<{ url: string; binding: string }> {
  if (!ctx.oidc) throw new HttpProblem(404, 'oidc_not_configured', 'OIDC is not configured on this instance');
  await rateLimit(ctx, `oidc:ip:${meta.ip}`, 30, TTL);
  if (input.mode === 'link') {
    if (!input.principal) throw new HttpProblem(401, 'unauthenticated', 'Authentication required');
    requireFresh(ctx, input.principal);
  }
  // The setup token is checked here and only the result travels with the
  // challenge, so the token never reaches the identity provider or a URL.
  const setup = input.mode === 'login' && ctx.config.setupToken !== null && typeof input.setupToken === 'string'
    && safeEqual(sha256Hex(input.setupToken), sha256Hex(ctx.config.setupToken));
  const state = randomToken(24), nonce = randomToken(24), codeVerifier = client.randomPKCECodeVerifier(), binding = randomToken(24);
  await ctx.db.query('INSERT INTO auth_challenges (id, kind, key, user_id, data, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [uuidv7(), 'oidc', sha256Hex(state), input.mode === 'link' ? input.principal!.userId : null,
      { nonce, codeVerifier, mode: input.mode, binding: sha256Hex(binding), setup }, new Date(ctx.now().getTime() + TTL)]);
  return { url: await ctx.oidc.authorizationUrl({ state, nonce, codeVerifier }), binding };
}

export type CallbackResult = { kind: 'linked' } | { kind: 'login'; signIn: SignIn };

export async function callback(ctx: AuthContext, input: { query: URLSearchParams; binding: string | undefined; principal: Principal | null }, meta: Meta): Promise<CallbackResult> {
  if (!ctx.oidc) throw new HttpProblem(404, 'oidc_not_configured', 'OIDC is not configured on this instance');
  await rateLimit(ctx, `oidc:ip:${meta.ip}`, 30, TTL);
  const state = input.query.get('state');
  const invalid = () => new HttpProblem(400, 'oidc_state_invalid', 'Sign-in session is invalid or expired; start again');
  if (!state) throw invalid();
  const { rows } = await ctx.db.query<{ user_id: Id | null; data: { nonce: string; codeVerifier: string; mode: 'login' | 'link'; binding: string; setup?: boolean } }>(
    `UPDATE auth_challenges SET consumed_at = $2 WHERE key = $1 AND kind = 'oidc' AND consumed_at IS NULL AND expires_at > $2 RETURNING user_id, data`,
    [sha256Hex(state), ctx.now()]);
  const ch = rows[0];
  if (!ch || !input.binding || !safeEqual(sha256Hex(input.binding), ch.data.binding)) throw invalid();
  if (input.query.get('error')) throw new HttpProblem(400, 'oidc_denied', 'The identity provider reported an error');
  let claims;
  try {
    claims = await ctx.oidc.exchange({ callbackUrl: `${ctx.config.publicOrigin}/v1/auth/oidc/callback?${input.query.toString()}`, state, nonce: ch.data.nonce, codeVerifier: ch.data.codeVerifier });
  } catch { throw new HttpProblem(400, 'oidc_failed', 'The identity provider response could not be verified'); }

  if (ch.data.mode === 'link') {
    // The browser that finishes the link must be the signed-in owner who started it.
    if (!input.principal || input.principal.userId !== ch.user_id) throw new HttpProblem(403, 'forbidden', 'Forbidden');
    const r = await ctx.db.query(
      'INSERT INTO oidc_identities (id, user_id, issuer, subject, email, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (issuer, subject) DO NOTHING',
      [uuidv7(), ch.user_id, claims.issuer, claims.subject, claims.email, ctx.now()]);
    if (!r.rowCount) {
      const mine = await ctx.db.query('SELECT 1 FROM oidc_identities WHERE issuer = $1 AND subject = $2 AND user_id = $3', [claims.issuer, claims.subject, ch.user_id]);
      if (!mine.rowCount) throw new HttpProblem(409, 'oidc_already_linked', 'That identity is linked to a different account');
    } else await audit(ctx.db, ch.user_id, 'credential.oidc_linked', ch.user_id, { issuer: claims.issuer }, ctx.now());
    return { kind: 'linked' };
  }

  const known = await ctx.db.query<{ user_id: Id; status: string }>(
    'SELECT i.user_id, u.status FROM oidc_identities i JOIN users u ON u.id = i.user_id WHERE i.issuer = $1 AND i.subject = $2', [claims.issuer, claims.subject]);
  if (known.rows[0]) {
    if (known.rows[0].status !== 'active') throw problem.invalidCredentials();
    const session = await createSession(ctx, known.rows[0].user_id, 'active', meta);
    await audit(ctx.db, known.rows[0].user_id, 'login.succeeded', known.rows[0].user_id, { method: 'oidc', issuer: claims.issuer }, ctx.now());
    return { kind: 'login', signIn: { session, userId: known.rows[0].user_id, mfaRequired: false } };
  }
  // Unknown identity: create an account only from a verified email, never merge into an existing one.
  if (!claims.email || !claims.emailVerified) throw new HttpProblem(403, 'oidc_email_unverified', 'The identity provider did not supply a verified email address');
  const userId = await withTx(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
    const first = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]!.n === 0;
    if (!first && ctx.config.registration !== 'open') throw new HttpProblem(403, 'registration_closed', 'Registration is closed on this instance');
    // Bootstrap through the identity provider honours the setup token too: with a
    // public provider, anyone with an account there could otherwise become admin.
    if (first && ctx.config.setupToken !== null && ch.data.setup !== true) throw new HttpProblem(403, 'setup_token_required', 'A valid setup token is required to create the first account');
    if ((await tx.query("SELECT 1 FROM users WHERE email = $1 AND status <> 'deleted'", [claims.email])).rowCount) {
      throw new HttpProblem(409, 'oidc_link_required', 'An account with this email exists; sign in and link the identity from your account settings');
    }
    const id = uuidv7();
    await tx.query('INSERT INTO users (id, email, instance_role, email_verified_at, created_at) VALUES ($1,$2,$3,$4,$4)', [id, claims.email, first ? 'admin' : 'user', ctx.now()]);
    await tx.query('INSERT INTO oidc_identities (id, user_id, issuer, subject, email, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [uuidv7(), id, claims.issuer, claims.subject, claims.email, ctx.now()]);
    await audit(tx, id, 'account.registered', id, { via: 'oidc', bootstrap_admin: first }, ctx.now());
    return id;
  });
  const session = await createSession(ctx, userId, 'active', meta);
  return { kind: 'login', signIn: { session, userId, mfaRequired: false } };
}

export const unlink = (ctx: AuthContext, p: Principal, id: Id) =>
  removeGuarded(ctx, p, async (tx) => (await tx.query('DELETE FROM oidc_identities WHERE id = $1 AND user_id = $2', [id, p.userId])).rowCount ?? 0, 'credential.oidc_unlinked', { identity: id });
