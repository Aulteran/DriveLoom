// Instance administration: users, invitations, default units, SMTP and OIDC settings and the audit log. Admins manage
// accounts, never vehicle data; nothing here reads a vehicle or a fuel record.
import type { HttpRequest, Route } from '../http/app.ts';
import { HttpProblem } from '../http/problem.ts';
import { invalid, obj } from '../http/validate.ts';
import { requireInstanceAdmin } from '../identity.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import { withTx } from '../db.ts';
import { audit, normaliseEmail, rateLimit, type AuthContext } from '../auth/context.ts';
import { Integrations, parseOidc, parseSmtp, sameIssuer } from './integrations.ts';
import { randomToken, sha256Hex } from '../auth/crypto.ts';
import { requireFresh, revokeAll } from '../auth/sessions.ts';
import { getInstanceDefaults, parseUnits, setInstanceDefaults } from '../preferences.ts';

const ADMIN_LOCK = 7_165_202; // same key as the bootstrap lock: serialises every change to the set of admins
const notFound = () => new HttpProblem(404, 'user_not_found', 'User not found');

export function adminRoutes(ctx: AuthContext): Route[] {
  const admin = (r: HttpRequest) => requireInstanceAdmin(r.ctx);
  const target = (r: HttpRequest): Id => { const id = r.params['userId']; if (!isUuid(id)) throw notFound(); return id; };

  /** Change one user under the admin lock, refusing to leave the instance without an active administrator. */
  async function change(r: HttpRequest, fn: (tx: Parameters<Parameters<typeof withTx>[1]>[0], user: { id: Id; instance_role: string; status: string }) => Promise<void>): Promise<void> {
    const p = admin(r);
    requireFresh(ctx, p);
    const id = target(r);
    if (id === p.userId) throw new HttpProblem(409, 'cannot_change_self', 'Conflict', 'Ask another administrator to change your own account.');
    await withTx(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_LOCK]);
      const u = (await tx.query<{ id: Id; instance_role: string; status: string }>("SELECT id, instance_role, status FROM users WHERE id = $1 AND status <> 'deleted' FOR UPDATE", [id])).rows[0];
      if (!u) throw notFound();
      await fn(tx, u);
      const left = await tx.query("SELECT 1 FROM users WHERE instance_role = 'admin' AND status = 'active' LIMIT 1");
      if (!left.rowCount) throw new HttpProblem(409, 'last_admin', 'Conflict', 'The instance must keep an active administrator.');
    });
  }

  const integ = (): Integrations => {
    if (!ctx.integrations) throw new HttpProblem(501, 'settings_unavailable', 'Not implemented', 'This server does not manage SMTP or OIDC settings.');
    return ctx.integrations;
  };
  /** Sensitive changes need a recent sign-in, like invitations do. */
  const sensitive = (r: HttpRequest) => { const p = admin(r); requireFresh(ctx, p); return p; };
  /** Accounts whose only primary sign-in method is an OIDC identity from an issuer other than `keep`. */
  async function stranded(keep: string | null): Promise<number> {
    const { rows } = await ctx.db.query<{ issuer: string }>(
      `SELECT o.issuer FROM oidc_identities o JOIN users u ON u.id = o.user_id
        WHERE u.status <> 'deleted' AND NOT EXISTS (SELECT 1 FROM password_credentials p WHERE p.user_id = o.user_id)
          AND NOT EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id = o.user_id)`);
    return rows.filter((x) => keep === null || !sameIssuer(x.issuer, keep)).length;
  }
  const strandedProblem = (n: number) => new HttpProblem(409, 'oidc_identities_in_use', 'Conflict', `${n} account${n === 1 ? '' : 's'} can sign in only through the current identity provider. Give them a password or passkey first.`);
  /** What must hold before email goes away (removed or turned off). */
  const guardSmtpOff = () => {
    if (ctx.config.requireEmailVerification || ctx.config.emailSignInCodes) throw new HttpProblem(409, 'email_features_enabled', 'Conflict', 'Email verification or email sign-in codes are enabled by the server environment and need SMTP. Disable them there first.');
  };
  /** What must hold before single sign-on goes away (removed or turned off). */
  const guardOidcOff = async () => {
    if (!ctx.config.passwordEnabled) throw new HttpProblem(409, 'password_login_disabled', 'Conflict', 'Password sign-in is disabled, so OIDC is the only way in. Enable password sign-in first.');
    const n = await stranded(null);
    if (n) throw strandedProblem(n);
  };
  const failure = (code: string, title: string, e: unknown) => new HttpProblem(502, code, title, (e instanceof Error ? e.message : String(e)).slice(0, 300));

  return [
    { method: 'GET', path: '/v1/admin/users', async handler(r) {
      admin(r);
      const { rows } = await ctx.db.query(
        `SELECT u.id, u.email, u.display_name, u.instance_role, u.status, u.created_at,
                (SELECT count(*)::int FROM vehicle_members m WHERE m.user_id = u.id AND m.role = 'owner') AS owned
           FROM users u WHERE u.status <> 'deleted' ORDER BY u.id`);
      return { status: 200, body: { items: rows.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, instanceRole: u.instance_role, status: u.status, createdAt: u.created_at.toISOString(), ownedVehicleCount: u.owned })) } };
    } },
    { method: 'PUT', path: '/v1/admin/users/:userId/status', async handler(r) {
      const { status } = obj(r.body, ['status']);
      if (status !== 'active' && status !== 'disabled') throw invalid("status must be 'active' or 'disabled'.");
      await change(r, async (tx, u) => {
        await tx.query('UPDATE users SET status = $2 WHERE id = $1', [u.id, status]);
        await audit(tx, admin(r).userId, status === 'disabled' ? 'admin.user_disabled' : 'admin.user_enabled', u.id, {}, ctx.now());
      });
      if (status === 'disabled') await revokeAll(ctx, target(r), null, 'account_disabled');
      return { status: 204 };
    } },
    { method: 'PUT', path: '/v1/admin/users/:userId/role', async handler(r) {
      const { role } = obj(r.body, ['role']);
      if (role !== 'admin' && role !== 'user') throw invalid("role must be 'admin' or 'user'.");
      await change(r, async (tx, u) => {
        await tx.query('UPDATE users SET instance_role = $2 WHERE id = $1', [u.id, role]);
        await audit(tx, admin(r).userId, 'admin.role_changed', u.id, { from: u.instance_role, to: role }, ctx.now());
      });
      return { status: 204 };
    } },
    { method: 'GET', path: '/v1/admin/invites', async handler(r) {
      admin(r);
      const { rows } = await ctx.db.query('SELECT id, email, created_at, expires_at, used_at FROM invites ORDER BY id DESC LIMIT 200');
      return { status: 200, body: { items: rows.map((i) => ({ id: i.id, email: i.email, createdAt: i.created_at.toISOString(), expiresAt: i.expires_at.toISOString(), usedAt: i.used_at?.toISOString() ?? null })) } };
    } },
    { method: 'POST', path: '/v1/admin/invites', async handler(r) {
      const p = admin(r);
      requireFresh(ctx, p);
      const b = obj(r.body ?? {}, ['email', 'expiresInDays']);
      const email = b['email'] === undefined || b['email'] === null || b['email'] === '' ? null : normaliseEmail(b['email']);
      const days = b['expiresInDays'] === undefined ? 7 : b['expiresInDays'];
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) throw invalid('expiresInDays must be a whole number from 1 to 30.');
      const id = uuidv7(), token = randomToken(32), expiresAt = new Date(ctx.now().getTime() + days * 86_400_000);
      await ctx.db.query('INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, sha256Hex(token), email, p.userId, ctx.now(), expiresAt]);
      await audit(ctx.db, p.userId, 'admin.invite_created', null, { invite: id }, ctx.now());
      // The token is shown once; only its hash is stored.
      return { status: 201, body: { id, token, email, expiresAt: expiresAt.toISOString() } };
    } },
    { method: 'DELETE', path: '/v1/admin/invites/:inviteId', async handler(r) {
      const p = admin(r);
      const id = r.params['inviteId'];
      const del = isUuid(id) ? await ctx.db.query('DELETE FROM invites WHERE id = $1 AND used_at IS NULL', [id]) : { rowCount: 0 };
      if (!del.rowCount) throw new HttpProblem(404, 'invite_not_found', 'Invitation not found or already used');
      await audit(ctx.db, p.userId, 'admin.invite_revoked', null, { invite: id }, ctx.now());
      return { status: 204 };
    } },
    // Instance default units: what every user sees until they choose their own.
    { method: 'GET', path: '/v1/admin/settings/units', async handler(r) {
      admin(r);
      return { status: 200, body: await getInstanceDefaults(ctx.db) };
    } },
    { method: 'PUT', path: '/v1/admin/settings/units', async handler(r) {
      const p = admin(r);
      const patch = parseUnits(r.body, 'Request body', false);
      const next = await setInstanceDefaults(ctx.db, patch);
      await audit(ctx.db, p.userId, 'admin.unit_defaults_changed', null, { ...patch }, ctx.now());
      return { status: 200, body: next };
    } },
    // SMTP and OIDC. Secrets are write-only: the views say only whether one is stored.
    { method: 'GET', path: '/v1/admin/settings/smtp', async handler(r) { admin(r); return { status: 200, body: integ().smtpView() }; } },
    { method: 'PUT', path: '/v1/admin/settings/smtp', async handler(r) {
      const p = sensitive(r);
      const input = parseSmtp(r.body);
      const i = integ();
      if (i.smtpSource === 'env') throw Integrations.managed();
      if (input.enabled === false && i.smtpView().enabled) guardSmtpOff(); // turning it off, not editing a disabled one
      await i.saveSmtp(input);
      await audit(ctx.db, p.userId, 'admin.smtp_changed', null, { enabled: i.smtpView().enabled, host: input.settings.host, port: input.settings.port, security: input.settings.security, from: input.settings.from, username: !!input.settings.username, passwordChanged: input.password !== undefined }, ctx.now());
      return { status: 200, body: integ().smtpView() };
    } },
    { method: 'DELETE', path: '/v1/admin/settings/smtp', async handler(r) {
      const p = sensitive(r);
      const i = integ();
      if (i.smtpSource === 'env') await i.clearSmtp(); // refuses with managed_by_environment
      guardSmtpOff();
      await i.clearSmtp();
      await audit(ctx.db, p.userId, 'admin.smtp_removed', null, {}, ctx.now());
      return { status: 204 };
    } },
    { method: 'POST', path: '/v1/admin/settings/smtp/test', async handler(r) {
      const p = sensitive(r);
      await rateLimit(ctx, `smtp-test:${p.userId}`, 10, 10 * 60_000);
      const mailer = integ().mailer;
      if (!mailer) throw new HttpProblem(409, 'smtp_not_configured', 'Conflict', 'Email is not turned on. Save the settings with email enabled first.');
      const to = (await ctx.db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [p.userId])).rows[0]!.email;
      try { await mailer.send(to, 'DriveLoom test message', 'This is a test message from your DriveLoom instance. Email delivery works.'); }
      catch (e) { throw failure('smtp_test_failed', 'The test message could not be sent', e); }
      await audit(ctx.db, p.userId, 'admin.smtp_tested', null, {}, ctx.now());
      return { status: 200, body: { sentTo: to } };
    } },
    { method: 'GET', path: '/v1/admin/settings/oidc', async handler(r) { admin(r); return { status: 200, body: integ().oidcView() }; } },
    { method: 'PUT', path: '/v1/admin/settings/oidc', async handler(r) {
      const p = sensitive(r);
      const input = parseOidc(r.body);
      const i = integ();
      if (i.oidcSource === 'env') throw Integrations.managed();
      if (input.enabled === false) { if (i.oidcView().enabled) await guardOidcOff(); }
      else { const n = await stranded(input.settings.issuer); if (n) throw strandedProblem(n); }
      await i.saveOidc(input);
      await audit(ctx.db, p.userId, 'admin.oidc_changed', null, { enabled: i.oidcView().enabled, issuer: input.settings.issuer, clientId: input.settings.clientId, secretChanged: input.clientSecret !== undefined }, ctx.now());
      return { status: 200, body: integ().oidcView() };
    } },
    { method: 'DELETE', path: '/v1/admin/settings/oidc', async handler(r) {
      const p = sensitive(r);
      const i = integ();
      if (i.oidcSource === 'env') await i.clearOidc(); // refuses with managed_by_environment
      await guardOidcOff();
      await i.clearOidc();
      await audit(ctx.db, p.userId, 'admin.oidc_removed', null, {}, ctx.now());
      return { status: 204 };
    } },
    { method: 'POST', path: '/v1/admin/settings/oidc/test', async handler(r) {
      const p = sensitive(r);
      await rateLimit(ctx, `oidc-test:${p.userId}`, 10, 10 * 60_000);
      const provider = integ().oidc;
      if (!provider?.discover) throw new HttpProblem(409, 'oidc_not_configured', 'Conflict', 'Single sign-on is not turned on. Save the settings with it enabled first.');
      try { return { status: 200, body: await provider.discover() }; }
      catch (e) { throw failure('oidc_test_failed', 'The identity provider could not be reached', e); }
    } },
    { method: 'GET', path: '/v1/admin/audit', async handler(r) {
      admin(r);
      const limitRaw = r.query.get('limit') ?? '100', before = r.query.get('before');
      if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 500) throw invalid('limit must be 1 to 500.');
      if (before !== null && !isUuid(before)) throw invalid('before must be an event id.');
      const { rows } = await ctx.db.query(
        'SELECT id, occurred_at, actor_id, action, subject_type, subject_id, details FROM audit_events WHERE ($1::uuid IS NULL OR id < $1) ORDER BY id DESC LIMIT $2', [before, Number(limitRaw)]);
      return { status: 200, body: { items: rows.map((e) => ({ id: e.id, occurredAt: e.occurred_at.toISOString(), actorId: e.actor_id, action: e.action, subjectType: e.subject_type, subjectId: e.subject_id, details: e.details })) } };
    } },
  ];
}
