// HTTP surface of the auth module. Contract: openapi.yaml, tag `auth`.
import { SESSION_COOKIE, type AuthMode, type HttpRequest, type HttpResult, type Route } from '../http/app.ts';
import { HttpProblem } from '../http/problem.ts';
import { requirePrincipal } from '../identity.ts';
import { isUuid } from '../ids.ts';
import type { Id } from '../types.ts';
import type { AuthContext } from './context.ts';
import type { NewSession } from './sessions.ts';
import * as acct from './accounts.ts';
import * as sess from './sessions.ts';
import * as pk from './passkeys.ts';
import * as oidc from './oidc.ts';

const OIDC_BINDING_COOKIE = 'dl_oidc';

function cookie(ctx: AuthContext, name: string, value: string, maxAgeSec: number, path = '/'): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSec}${ctx.config.secureCookies ? '; Secure' : ''}`;
}
const clearCookie = (ctx: AuthContext, name: string, path = '/') => cookie(ctx, name, '', 0, path);

function body(req: HttpRequest): Record<string, unknown> {
  if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpProblem(400, 'invalid_request', 'Invalid request', 'a JSON object body is required');
  return req.body as Record<string, unknown>;
}
const meta = (req: HttpRequest) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });

function sessionResult(ctx: AuthContext, s: NewSession, extra: Record<string, unknown> = {}): HttpResult {
  const maxAge = Math.max(1, Math.round((s.expiresAt.getTime() - ctx.now().getTime()) / 1000));
  return {
    status: 200,
    body: { state: s.state === 'pending' ? 'mfa_required' : 'signed_in', csrf_token: s.csrfToken, ...extra },
    headers: { 'set-cookie': cookie(ctx, SESSION_COOKIE, s.token, maxAge) },
  };
}

export function authRoutes(ctx: AuthContext): Route[] {
  const r = (method: Route['method'], path: string, auth: AuthMode, handler: Route['handler']): Route => ({ method, path, auth, handler });
  const ok = (status = 204, b?: unknown): HttpResult => ({ status, ...(b === undefined ? {} : { body: b }) });
  const idParam = (req: HttpRequest): Id => {
    const id = req.params['id'];
    if (!isUuid(id)) throw new HttpProblem(404, 'not_found', 'Not found');
    return id;
  };

  return [
    r('POST', '/v1/auth/register', 'none', async (req) => {
      const b = body(req);
      const out = await acct.register(ctx, { email: b['email'], password: b['password'], displayName: b['display_name'], setupToken: b['setup_token'], inviteToken: b['invite_token'] }, meta(req));
      return ok(202, { status: out.status });
    }),
    r('POST', '/v1/auth/verify-email', 'none', async (req) => {
      const b = body(req);
      await acct.verifyEmail(ctx, { email: b['email'], code: b['code'] }, meta(req));
      return ok();
    }),
    r('POST', '/v1/auth/login', 'none', async (req) => {
      const b = body(req);
      const out = await acct.login(ctx, { email: b['email'], password: b['password'] }, meta(req));
      return sessionResult(ctx, out.session, out.mfaMethod ? { mfa_method: out.mfaMethod } : {});
    }),
    r('POST', '/v1/auth/mfa/totp', 'pending', async (req) => {
      const b = body(req);
      const out = await acct.completeMfa(ctx, { sessionId: req.session!.sessionId, userId: req.session!.userId }, { code: b['code'], recoveryCode: b['recovery_code'] }, meta(req));
      return sessionResult(ctx, out.session);
    }),
    r('POST', '/v1/auth/mfa/email', 'pending', async (req) => {
      const out = await acct.completeEmailMfa(ctx, { sessionId: req.session!.sessionId, userId: req.session!.userId }, { code: body(req)['code'] }, meta(req));
      return sessionResult(ctx, out.session);
    }),
    r('POST', '/v1/auth/logout', 'required', async (req) => {
      const p = requirePrincipal(req.ctx);
      await sess.revokeSession(ctx, p.userId, p.sessionId);
      return { status: 204, headers: { 'set-cookie': clearCookie(ctx, SESSION_COOKIE) } };
    }),
    r('GET', '/v1/auth/session', 'required', async (req) => {
      const p = requirePrincipal(req.ctx);
      return ok(200, { csrf_token: req.session!.csrfToken, session_id: p.sessionId, account: await acct.describeAccount(ctx, p) });
    }),
    r('POST', '/v1/auth/reauth', 'required', async (req) => {
      const b = body(req);
      await acct.reauthenticate(ctx, requirePrincipal(req.ctx), { password: b['password'], code: b['code'] }, meta(req));
      return ok();
    }),
    r('PATCH', '/v1/auth/account', 'required', async (req) => {
      await acct.updateProfile(ctx, requirePrincipal(req.ctx), { displayName: body(req)['display_name'] });
      return ok();
    }),
    r('DELETE', '/v1/auth/account', 'required', async (req) => {
      await acct.deleteAccount(ctx, requirePrincipal(req.ctx));
      return { status: 204, headers: { 'set-cookie': clearCookie(ctx, SESSION_COOKIE) } };
    }),
    // Public facts the sign-in screen needs before anyone is authenticated.
    r('GET', '/v1/auth/instance', 'none', async () => {
      const empty = !(await ctx.db.query('SELECT 1 FROM users LIMIT 1')).rowCount;
      return ok(200, {
        registration: ctx.config.registration, password_login: ctx.config.passwordEnabled, oidc: !!ctx.oidc, email_recovery: !!ctx.mailer,
        needs_setup: empty, setup_token_required: empty && ctx.config.setupToken !== null,
      });
    }),
    // --- sessions ---
    r('GET', '/v1/auth/sessions', 'required', async (req) => {
      const p = requirePrincipal(req.ctx);
      const rows = await sess.listSessions(ctx, p.userId);
      return ok(200, { sessions: rows.map((s) => ({ id: s.id, created_at: s.created_at, last_seen_at: s.last_seen_at, user_agent: s.user_agent, current: s.id === p.sessionId })) });
    }),
    r('DELETE', '/v1/auth/sessions/:id', 'required', async (req) => {
      const p = requirePrincipal(req.ctx);
      if (!(await sess.revokeSession(ctx, p.userId, idParam(req)))) throw new HttpProblem(404, 'not_found', 'Not found');
      return ok();
    }),
    r('POST', '/v1/auth/sessions/revoke-others', 'required', async (req) => {
      const p = requirePrincipal(req.ctx);
      return ok(200, { revoked: await sess.revokeAll(ctx, p.userId, p.sessionId, 'user_request') });
    }),
    // --- password and recovery ---
    r('PUT', '/v1/auth/password', 'required', async (req) => {
      const b = body(req);
      await acct.setPassword(ctx, requirePrincipal(req.ctx), { currentPassword: b['current_password'], newPassword: b['new_password'] });
      return ok();
    }),
    r('DELETE', '/v1/auth/password', 'required', async (req) => { await acct.removePassword(ctx, requirePrincipal(req.ctx)); return ok(); }),
    r('POST', '/v1/auth/recovery/request', 'none', async (req) => {
      await acct.recoveryRequest(ctx, { email: body(req)['email'] }, meta(req)); // delivery deliberately not awaited
      return ok(202, { status: 'accepted' });
    }),
    r('POST', '/v1/auth/recovery/complete', 'none', async (req) => {
      const b = body(req);
      await acct.recoveryComplete(ctx, { email: b['email'], code: b['code'], newPassword: b['new_password'] }, meta(req));
      return ok();
    }),
    // --- TOTP ---
    r('POST', '/v1/auth/totp', 'required', async (req) => {
      const out = await acct.totpBegin(ctx, requirePrincipal(req.ctx));
      return ok(200, { secret: out.secret, otpauth_uri: out.otpauthUri });
    }),
    r('POST', '/v1/auth/totp/confirm', 'required', async (req) => {
      const out = await acct.totpConfirm(ctx, requirePrincipal(req.ctx), body(req)['code']);
      return ok(200, { recovery_codes: out.recoveryCodes });
    }),
    r('DELETE', '/v1/auth/totp', 'required', async (req) => { await acct.totpRemove(ctx, requirePrincipal(req.ctx)); return ok(); }),
    // --- passkeys ---
    r('POST', '/v1/auth/passkeys/register/options', 'required', async (req) => ok(200, await pk.registerOptions(ctx, requirePrincipal(req.ctx)))),
    r('POST', '/v1/auth/passkeys/register/verify', 'required', async (req) => {
      const b = body(req);
      return ok(201, await pk.registerVerify(ctx, requirePrincipal(req.ctx), b['response'], b['label']));
    }),
    r('DELETE', '/v1/auth/passkeys/:id', 'required', async (req) => { await pk.remove(ctx, requirePrincipal(req.ctx), idParam(req)); return ok(); }),
    r('POST', '/v1/auth/passkeys/login/options', 'none', async (req) => ok(200, await pk.loginOptions(ctx, meta(req)))),
    r('POST', '/v1/auth/passkeys/login/verify', 'none', async (req) => sessionResult(ctx, (await pk.loginVerify(ctx, body(req)['response'], meta(req))).session)),
    // --- OIDC ---
    r('POST', '/v1/auth/oidc/start', 'optional', async (req) => {
      const mode = body(req)['mode'] === 'link' ? 'link' : 'login';
      const out = await oidc.start(ctx, { mode, principal: req.ctx.principal }, meta(req));
      return { status: 200, body: { authorization_url: out.url }, headers: { 'set-cookie': cookie(ctx, OIDC_BINDING_COOKIE, out.binding, 600, '/v1/auth/oidc') } };
    }),
    r('GET', '/v1/auth/oidc/callback', 'optional', async (req) => {
      // A browser arriving from the identity provider is sent back into the web client; API clients get JSON.
      const browser = /text\/html/.test(String(req.headers['accept'] ?? ''));
      const clear = clearCookie(ctx, OIDC_BINDING_COOKIE, '/v1/auth/oidc');
      let out: Awaited<ReturnType<typeof oidc.callback>>;
      try {
        out = await oidc.callback(ctx, { query: req.query, binding: req.cookies[OIDC_BINDING_COOKIE], principal: req.ctx.principal }, meta(req));
      } catch (e) {
        if (!browser || !(e instanceof HttpProblem)) throw e;
        return { status: 303, headers: { location: `/#/signin?error=${encodeURIComponent(e.code)}`, 'set-cookie': clear } };
      }
      if (out.kind === 'linked') return browser ? { status: 303, headers: { location: '/#/account?linked=1', 'set-cookie': clear } } : { status: 200, body: { status: 'linked' }, headers: { 'set-cookie': clear } };
      const res = sessionResult(ctx, out.signIn.session);
      res.headers = { 'set-cookie': [res.headers!['set-cookie'] as string, clear] };
      if (browser) return { status: 303, headers: { ...res.headers, location: '/#/' } };
      return res;
    }),
    r('DELETE', '/v1/auth/oidc/identities/:id', 'required', async (req) => { await oidc.unlink(ctx, requirePrincipal(req.ctx), idParam(req)); return ok(); }),
  ];
}
