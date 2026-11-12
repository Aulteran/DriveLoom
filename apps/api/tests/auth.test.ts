import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpProblem } from '../src/http/problem.ts';
import { configFromEnv } from '../src/auth/config.ts';
import * as acct from '../src/auth/accounts.ts';
import * as sess from '../src/auth/sessions.ts';
import { harness, meta, PW, principalFor, signUp, currentTotp, nextTotp } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof HttpProblem) return e.code; throw e; }
  return 'no_error';
}
async function using<T>(over: Parameters<typeof harness>[0], opts: Parameters<typeof harness>[1], fn: (h: NonNullable<Awaited<ReturnType<typeof harness>>>) => Promise<T>) {
  const h = (await harness(over, opts))!;
  try { return await fn(h); } finally { await h.drop(); }
}

test('first account becomes admin; later registration follows policy', { skip }, () => using({ registration: 'closed' }, {}, async (h) => {
  await acct.register(h.ctx, { email: 'Admin@Example.test', password: PW }, meta);
  const { userId } = await acct.login(h.ctx, { email: 'admin@example.test', password: PW }, meta);
  const row = await h.ctx.db.query('SELECT instance_role FROM users WHERE id = $1', [userId]);
  assert.equal(row.rows[0].instance_role, 'admin');
  assert.equal(await code(acct.register(h.ctx, { email: 'b@example.test', password: PW }, meta)), 'registration_closed');
}));

test('concurrent first registrations produce exactly one admin', { skip }, () => using({ registration: 'open' }, {}, async (h) => {
  await Promise.all(Array.from({ length: 4 }, (_, i) => acct.register(h.ctx, { email: `u${i}@example.test`, password: PW }, { ...meta, ip: `198.51.100.${i}` })));
  const r = await h.ctx.db.query("SELECT count(*)::int n FROM users WHERE instance_role = 'admin'");
  assert.equal(r.rows[0].n, 1);
}));

test('password policy and duplicate email without SMTP', { skip }, () => using({}, { mail: false }, async (h) => {
  assert.equal(await code(acct.register(h.ctx, { email: 'a@example.test', password: 'short' }, meta)), 'invalid_request');
  assert.equal(await code(acct.register(h.ctx, { email: 'not-an-email', password: PW }, meta)), 'invalid_request');
  await acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta);
  assert.equal(await code(acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'email_taken');
}));

test('login does not reveal whether an account exists', { skip }, () => using({}, {}, async (h) => {
  await acct.register(h.ctx, { email: 'real@example.test', password: PW }, meta);
  const grab = async (email: string, password: string) => { try { await acct.login(h.ctx, { email, password }, meta); } catch (e) { return e as HttpProblem; } throw new Error('expected failure'); };
  const wrongPw = await grab('real@example.test', 'wrong wrong wrong');
  const noUser = await grab('ghost@example.test', 'wrong wrong wrong');
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, wrongPw.status);
  assert.equal(noUser.code, wrongPw.code);
  assert.equal(noUser.message, wrongPw.message);
}));

test('login is rate limited per account and per IP', { skip }, () => using({}, {}, async (h) => {
  await acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta);
  for (let i = 0; i < 10; i++) assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: 'nope nope nope nope' }, { ...meta, ip: `203.0.113.${i}` })), 'invalid_credentials');
  // Even the right password is refused once the account window is spent, from a fresh IP.
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: PW }, { ...meta, ip: '203.0.113.99' })), 'rate_limited');
  h.clock.t += 11 * 60_000;
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'no_error');
}));

test('SMTP misconfiguration is rejected at startup and at send time', { skip }, async () => {
  const env = { DRIVELOOM_PUBLIC_ORIGIN: 'https://dl.example', DRIVELOOM_SECRET_KEY: 'x'.repeat(40), DRIVELOOM_REQUIRE_EMAIL_VERIFICATION: '1' };
  assert.throws(() => configFromEnv(env, false), /needs SMTP/);
  assert.doesNotThrow(() => configFromEnv(env, true));
  assert.throws(() => configFromEnv({ ...env, DRIVELOOM_REQUIRE_EMAIL_VERIFICATION: '0', DRIVELOOM_PASSWORD_LOGIN: '0' }, false), /no primary sign-in/);
  await using({ requireEmailVerification: true }, {}, async (h) => {
    h.mailer.fail = true;
    assert.equal(await code(acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'email_unavailable');
    const n = await h.ctx.db.query('SELECT count(*)::int n FROM users');
    assert.equal(n.rows[0].n, 0, 'no half-created account');
  });
});

test('email verification: required, single use, expiring, attempt limited', { skip }, () => using({ requireEmailVerification: true }, {}, async (h) => {
  const email = 'a@example.test';
  assert.deepEqual(await acct.register(h.ctx, { email, password: PW }, meta), { status: 'verification_sent' });
  assert.equal(await code(acct.login(h.ctx, { email, password: PW }, meta)), 'email_not_verified');
  const good = h.mailer.lastCode(email)!;
  const bad = good === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 5; i++) assert.equal(await code(acct.verifyEmail(h.ctx, { email, code: bad }, { ...meta, ip: `203.0.113.${i}` })), 'invalid_code');
  // Attempts are exhausted: even the right code no longer works.
  assert.equal(await code(acct.verifyEmail(h.ctx, { email, code: good }, meta)), 'invalid_code');
  // A fresh code (via re-registration notice path is generic; use recovery of verification by new code) is issued by a new account only,
  // so verify the happy path, reuse and expiry on another address.
  const e2 = 'b@example.test';
  await acct.register(h.ctx, { email: e2, password: PW }, meta);
  const c2 = h.mailer.lastCode(e2)!;
  await acct.verifyEmail(h.ctx, { email: e2, code: c2 }, meta);
  assert.equal(await code(acct.verifyEmail(h.ctx, { email: e2, code: c2 }, meta)), 'invalid_code', 'reuse');
  assert.equal(await code(acct.login(h.ctx, { email: e2, password: PW }, meta)), 'no_error');
  const e3 = 'c@example.test';
  await acct.register(h.ctx, { email: e3, password: PW }, meta);
  const c3 = h.mailer.lastCode(e3)!;
  h.clock.t += 16 * 60_000;
  assert.equal(await code(acct.verifyEmail(h.ctx, { email: e3, code: c3 }, meta)), 'invalid_code', 'expired');
}));

test('registering an existing email with verification on gives the same answer and no code', { skip }, () => using({ requireEmailVerification: true }, {}, async (h) => {
  const first = await acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta);
  const second = await acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta);
  assert.deepEqual(first, second);
  assert.match(h.mailer.sent.at(-1)!.text, /already exists/);
}));

test('password recovery: generic request, single-use code, revokes every session', { skip }, () => using({}, {}, async (h) => {
  const a = await signUp(h, 'a@example.test');
  const before = await h.auth.resolveSession(a.session.token);
  assert.ok(before?.principal);
  await (await acct.recoveryRequest(h.ctx, { email: 'ghost@example.test' }, meta)).delivery; // no error, no mail
  assert.equal(h.mailer.sent.length, 0);
  await (await acct.recoveryRequest(h.ctx, { email: 'a@example.test' }, meta)).delivery;
  const c = h.mailer.lastCode('a@example.test')!;
  assert.equal(await code(acct.recoveryComplete(h.ctx, { email: 'a@example.test', code: c, newPassword: 'a brand new passphrase' }, meta)), 'no_error');
  assert.equal(await h.auth.resolveSession(a.session.token), null, 'old session revoked');
  assert.equal(await code(acct.recoveryComplete(h.ctx, { email: 'a@example.test', code: c, newPassword: 'another new passphrase' }, meta)), 'invalid_code', 'reuse');
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'invalid_credentials');
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: 'a brand new passphrase' }, meta)), 'no_error');
}));

test('recovery is unavailable without SMTP; operator reset works and is audited', { skip }, () => using({}, { mail: false }, async (h) => {
  await signUp(h, 'a@example.test');
  assert.equal(await code(acct.recoveryRequest(h.ctx, { email: 'a@example.test' }, meta)), 'email_not_configured');
  await acct.adminResetPassword(h.ctx, 'a@example.test', 'operator chosen passphrase');
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: 'operator chosen passphrase' }, meta)), 'no_error');
  const a = await h.ctx.db.query("SELECT 1 FROM audit_events WHERE action = 'recovery.operator_password_reset'");
  assert.equal(a.rowCount, 1);
}));

test('TOTP: second factor required, replay rejected, recovery codes single use', { skip }, () => using({}, {}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const p = await principalFor(h, s.session.token);
  const begin = await acct.totpBegin(h.ctx, p);
  const { recoveryCodes } = await acct.totpConfirm(h.ctx, p, await currentTotp(h, begin.secret));
  assert.equal(recoveryCodes.length, 10);

  const l = await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta);
  assert.equal(l.mfaRequired, true);
  const pend = await h.auth.resolveSession(l.session.token);
  assert.equal(pend?.pending, true);
  assert.equal(pend?.principal, null, 'pending session is not a principal');
  const ident = { sessionId: l.session.sessionId, userId: l.userId };

  // The code consumed during enrolment cannot be replayed to log in.
  assert.equal(await code(acct.completeMfa(h.ctx, ident, { code: await currentTotp(h, begin.secret) }, meta)), 'invalid_code');
  assert.equal(await code(acct.completeMfa(h.ctx, ident, { code: '000000' }, meta)), 'invalid_code');
  const good = await nextTotp(h, begin.secret);
  const done = await acct.completeMfa(h.ctx, ident, { code: good }, meta);
  assert.notEqual(done.session.token, l.session.token, 'session id rotated');
  assert.equal(await h.auth.resolveSession(l.session.token), null);
  assert.ok((await h.auth.resolveSession(done.session.token))?.principal);

  // Same code again from a new first-factor login: replay rejected.
  const l2 = await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta);
  assert.equal(await code(acct.completeMfa(h.ctx, { sessionId: l2.session.sessionId, userId: l2.userId }, { code: good }, meta)), 'invalid_code');
  // Recovery code works once.
  const rc = recoveryCodes[0]!;
  assert.equal(await code(acct.completeMfa(h.ctx, { sessionId: l2.session.sessionId, userId: l2.userId }, { recoveryCode: rc }, meta)), 'no_error');
  const l3 = await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta);
  assert.equal(await code(acct.completeMfa(h.ctx, { sessionId: l3.session.sessionId, userId: l3.userId }, { recoveryCode: rc }, meta)), 'invalid_code');
}));

test('TOTP codes outside the ±1 step window are rejected; secret is encrypted at rest', { skip }, () => using({}, {}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const p = await principalFor(h, s.session.token);
  const begin = await acct.totpBegin(h.ctx, p);
  const stored = await h.ctx.db.query('SELECT secret_enc FROM totp_credentials');
  assert.ok(!stored.rows[0].secret_enc.includes(begin.secret));
  h.clock.t += 120_000;
  const old = await currentTotp(h, begin.secret);
  h.clock.t -= 120_000;
  assert.equal(await code(acct.totpConfirm(h.ctx, p, old)), 'invalid_code');
}));

test('sensitive actions need recent authentication; reauth restores it', { skip }, () => using({}, {}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  h.clock.t += 11 * 60_000;
  const p = await principalFor(h, s.session.token);
  assert.equal(await code(acct.totpBegin(h.ctx, p)), 'reauth_required');
  assert.equal(await code(acct.reauthenticate(h.ctx, p, { password: 'wrong wrong wrong' }, meta)), 'invalid_credentials');
  await acct.reauthenticate(h.ctx, p, { password: PW }, meta);
  const fresh = await principalFor(h, s.session.token);
  assert.equal(await code(acct.totpBegin(h.ctx, fresh)), 'no_error');
}));

test('the last sign-in method cannot be removed', { skip }, () => using({}, {}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const p = await principalFor(h, s.session.token);
  assert.equal(await code(acct.removePassword(h.ctx, p)), 'last_credential');
  const still = await h.ctx.db.query('SELECT 1 FROM password_credentials');
  assert.equal(still.rowCount, 1);
}));

test('password change needs the current password and revokes other sessions', { skip }, () => using({}, {}, async (h) => {
  const a = await signUp(h, 'a@example.test');
  const b = await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta);
  const p = await principalFor(h, a.session.token);
  assert.equal(await code(acct.setPassword(h.ctx, p, { currentPassword: 'not it not it', newPassword: 'a brand new passphrase' })), 'invalid_credentials');
  await acct.setPassword(h.ctx, p, { currentPassword: PW, newPassword: 'a brand new passphrase' });
  assert.equal(await h.auth.resolveSession(b.session.token), null, 'other session revoked');
  assert.ok((await h.auth.resolveSession(a.session.token))?.principal, 'current session kept');
}));

test('session revocation, logout, expiry and idle timeout', { skip }, () => using({}, {}, async (h) => {
  const a = await signUp(h, 'a@example.test');
  const b = await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta);
  const p = await principalFor(h, a.session.token);
  assert.equal((await sess.listSessions(h.ctx, p.userId)).length, 2);
  assert.equal(await sess.revokeSession(h.ctx, p.userId, b.session.sessionId), true);
  assert.equal(await h.auth.resolveSession(b.session.token), null);
  // A user cannot revoke someone else's session.
  const other = await signUp(h, 'o@example.test');
  assert.equal(await sess.revokeSession(h.ctx, p.userId, other.session.sessionId), false);
  assert.ok(await h.auth.resolveSession(other.session.token));
  h.clock.t += 8 * 86_400_000; // idle > 7 days
  assert.equal(await h.auth.resolveSession(a.session.token), null);
}));

test('disabled accounts lose access immediately', { skip }, () => using({}, {}, async (h) => {
  const a = await signUp(h, 'a@example.test');
  await h.ctx.db.query("UPDATE users SET status = 'disabled'");
  assert.equal(await h.auth.resolveSession(a.session.token), null);
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'invalid_credentials');
}));

test('bootstrap can require a setup token', { skip }, () => using({ registration: 'closed', setupToken: 'a-long-setup-token-value' }, {}, async (h) => {
  assert.equal(await code(acct.register(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'setup_token_required');
  assert.equal(await code(acct.register(h.ctx, { email: 'a@example.test', password: PW, setupToken: 'wrong' }, meta)), 'setup_token_required');
  assert.equal((await h.ctx.db.query('SELECT 1 FROM users')).rowCount, 0);
  await acct.register(h.ctx, { email: 'a@example.test', password: PW, setupToken: 'a-long-setup-token-value' }, meta);
  const r = await h.ctx.db.query("SELECT instance_role FROM users WHERE email = 'a@example.test'");
  assert.equal(r.rows[0].instance_role, 'admin');
}));

test('recovery request answers before mail delivery, for known and unknown addresses alike', { skip }, () => using({}, {}, async (h) => {
  await signUp(h, 'a@example.test');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const send = h.mailer.send.bind(h.mailer);
  h.mailer.send = async (...a) => { await gate; return send(...a); };
  const known = await acct.recoveryRequest(h.ctx, { email: 'a@example.test' }, meta); // resolves while SMTP is still blocked
  const unknown = await acct.recoveryRequest(h.ctx, { email: 'ghost@example.test' }, meta);
  assert.equal(h.mailer.sent.length, 0);
  release();
  await Promise.all([known.delivery, unknown.delivery]);
  assert.equal(h.mailer.sent.length, 1);
}));
