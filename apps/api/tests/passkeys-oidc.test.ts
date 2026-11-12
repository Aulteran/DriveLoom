import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpProblem } from '../src/http/problem.ts';
import * as acct from '../src/auth/accounts.ts';
import * as pk from '../src/auth/passkeys.ts';
import * as oidc from '../src/auth/oidc.ts';
import { ORIGIN } from './helpers/index.ts';
import { SoftAuthenticator } from './helpers/webauthn.ts';
import { harness, meta, PW, principalFor, signUp, type Harness } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof HttpProblem) return e.code; throw e; }
  return 'no_error';
}
async function using<T>(over: Parameters<typeof harness>[0], fn: (h: Harness) => Promise<T>) {
  const h = (await harness(over))!;
  try { return await fn(h); } finally { await h.drop(); }
}
const rp = { origin: ORIGIN, rpId: 'driveloom.test' };

async function addPasskey(h: Harness, token: string, dev = new SoftAuthenticator()) {
  const p = await principalFor(h, token);
  const opts = await pk.registerOptions(h.ctx, p);
  const { id } = await pk.registerVerify(h.ctx, p, dev.create({ challenge: opts.challenge, ...rp }), 'laptop');
  return { dev, id, userHandle: Buffer.from(opts.user.id, 'base64url') };
}

test('passkeys: register several, sign in with one, counter advances', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const one = await addPasskey(h, s.session.token);
  const two = await addPasskey(h, s.session.token);
  assert.notEqual(one.id, two.id);
  const o = await pk.loginOptions(h.ctx, meta);
  const out = await pk.loginVerify(h.ctx, one.dev.get({ challenge: o.challenge, ...rp, userHandle: one.userHandle }), meta);
  assert.ok((await h.auth.resolveSession(out.session.token))?.principal, 'passkey sign-in is a full session (user verified)');
  const row = await h.ctx.db.query('SELECT counter::int c FROM passkeys WHERE id = $1', [one.id]);
  assert.equal(row.rows[0].c, 1);
}));

test('passkeys: challenge replay, wrong origin, wrong RP and unverified user are rejected', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const a = await addPasskey(h, s.session.token);
  const o = await pk.loginOptions(h.ctx, meta);
  const resp = a.dev.get({ challenge: o.challenge, ...rp });
  assert.equal(await code(pk.loginVerify(h.ctx, resp, meta)), 'no_error');
  assert.equal(await code(pk.loginVerify(h.ctx, a.dev.get({ challenge: o.challenge, ...rp }), meta)), 'invalid_credentials', 'challenge replay');
  const o2 = await pk.loginOptions(h.ctx, meta);
  assert.equal(await code(pk.loginVerify(h.ctx, a.dev.get({ challenge: o2.challenge, origin: 'https://evil.test', rpId: 'driveloom.test' }), meta)), 'invalid_credentials', 'origin');
  const o3 = await pk.loginOptions(h.ctx, meta);
  assert.equal(await code(pk.loginVerify(h.ctx, a.dev.get({ challenge: o3.challenge, origin: ORIGIN, rpId: 'evil.test' }), meta)), 'invalid_credentials', 'rp id');
  const o4 = await pk.loginOptions(h.ctx, meta);
  assert.equal(await code(pk.loginVerify(h.ctx, a.dev.get({ challenge: o4.challenge, ...rp, uv: false }), meta)), 'invalid_credentials', 'user verification');
  assert.equal(await code(pk.loginVerify(h.ctx, a.dev.get({ challenge: 'never-issued', ...rp }), meta)), 'invalid_credentials', 'unknown challenge');
  // Unknown credential is indistinguishable from a bad signature.
  assert.equal(await code(pk.loginVerify(h.ctx, new SoftAuthenticator().get({ challenge: (await pk.loginOptions(h.ctx, meta)).challenge, ...rp }), meta)), 'invalid_credentials');
}));

test('passkey registration: challenge is single use, bound to the user and to the origin', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const other = await signUp(h, 'b@example.test');
  const p = await principalFor(h, s.session.token);
  const po = await principalFor(h, other.session.token);
  const opts = await pk.registerOptions(h.ctx, p);
  const dev = new SoftAuthenticator();
  assert.equal(await code(pk.registerVerify(h.ctx, po, dev.create({ challenge: opts.challenge, ...rp }), '')), 'passkey_invalid', 'other user cannot use the challenge');
  assert.equal(await code(pk.registerVerify(h.ctx, p, dev.create({ challenge: opts.challenge, origin: 'https://evil.test', rpId: 'driveloom.test' }), '')), 'passkey_invalid', 'origin');
  assert.equal(await code(pk.registerVerify(h.ctx, p, dev.create({ challenge: opts.challenge, ...rp }), '')), 'passkey_invalid', 'challenge consumed by the failed attempts');
}));

test('credential removal: passkey and password, never both', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const a = await addPasskey(h, s.session.token);
  const p = await principalFor(h, s.session.token);
  await acct.removePassword(h.ctx, p); // allowed: a passkey remains
  assert.equal(await code(pk.remove(h.ctx, p, a.id)), 'last_credential');
  assert.equal(await code(acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta)), 'invalid_credentials');
}));

test('concurrent removal of the last two methods leaves one', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const a = await addPasskey(h, s.session.token);
  const p = await principalFor(h, s.session.token);
  const res = await Promise.all([code(acct.removePassword(h.ctx, p)), code(pk.remove(h.ctx, p, a.id))]);
  assert.deepEqual(res.sort(), ['last_credential', 'no_error']);
}));

test('removing a credential revokes other sessions', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const other = await acct.login(h.ctx, { email: 'a@example.test', password: PW }, meta);
  const a = await addPasskey(h, s.session.token);
  const p = await principalFor(h, s.session.token);
  await pk.remove(h.ctx, p, a.id);
  assert.equal(await h.auth.resolveSession(other.session.token), null);
  assert.ok(await h.auth.resolveSession(s.session.token));
}));

// ---- OIDC ----
async function oidcLogin(h: Harness, opts: { binding?: string | null; state?: string; principal?: Awaited<ReturnType<typeof principalFor>> | null; mode?: 'login' | 'link' } = {}) {
  const principal = opts.principal ?? null;
  const st = await oidc.start(h.ctx, { mode: opts.mode ?? 'login', principal }, meta);
  const state = new URL(st.url).searchParams.get('state')!;
  return oidc.callback(h.ctx, {
    query: new URLSearchParams({ code: 'abc', state: opts.state ?? state }),
    binding: opts.binding === null ? undefined : (opts.binding ?? st.binding), principal,
  }, meta);
}

test('OIDC: new verified identity registers; same issuer+subject signs in again', { skip }, () => using({ registration: 'open' }, async (h) => {
  const first = await oidcLogin(h);
  assert.equal(first.kind, 'login');
  const second = await oidcLogin(h);
  assert.equal(second.kind === 'login' && second.signIn.userId, first.kind === 'login' && first.signIn.userId);
  // Same subject from a different issuer is a different identity (a different account).
  h.oidc.claims = { ...h.oidc.claims, issuer: 'https://other-idp.test', email: 'second@example.test' };
  const third = await oidcLogin(h);
  assert.notEqual(third.kind === 'login' && third.signIn.userId, first.kind === 'login' && first.signIn.userId);
}));

test('OIDC: state is single use, bound to the browser, and must exist', { skip }, () => using({ registration: 'open' }, async (h) => {
  const st = await oidc.start(h.ctx, { mode: 'login', principal: null }, meta);
  const state = new URL(st.url).searchParams.get('state')!;
  const q = new URLSearchParams({ code: 'abc', state });
  assert.equal(await code(oidc.callback(h.ctx, { query: q, binding: 'someone-elses-cookie', principal: null }, meta)), 'oidc_state_invalid', 'login CSRF: wrong browser binding');
  // The failed attempt consumed the state, so even the right cookie cannot reuse it.
  assert.equal(await code(oidc.callback(h.ctx, { query: q, binding: st.binding, principal: null }, meta)), 'oidc_state_invalid');
  assert.equal(await code(oidcLogin(h, { state: 'forged' })), 'oidc_state_invalid');
  assert.equal(await code(oidcLogin(h, { binding: null })), 'oidc_state_invalid');
  const st2 = await oidc.start(h.ctx, { mode: 'login', principal: null }, meta);
  h.clock.t += 11 * 60_000;
  assert.equal(await code(oidc.callback(h.ctx, { query: new URLSearchParams({ state: new URL(st2.url).searchParams.get('state')! }), binding: st2.binding, principal: null }, meta)), 'oidc_state_invalid', 'expired');
}));

test('OIDC: failed token validation (nonce/signature) rejects sign-in and creates nothing', { skip }, () => using({ registration: 'open' }, async (h) => {
  h.oidc.reject = true;
  assert.equal(await code(oidcLogin(h)), 'oidc_failed');
  assert.equal((await h.ctx.db.query('SELECT count(*)::int n FROM users')).rows[0].n, 0);
}));

test('OIDC: unverified email is refused; existing email is never auto-linked', { skip }, () => using({ registration: 'open' }, async (h) => {
  h.oidc.claims = { ...h.oidc.claims, emailVerified: false };
  assert.equal(await code(oidcLogin(h)), 'oidc_email_unverified');
  await signUp(h, 'oidc@example.test');
  h.oidc.claims = { ...h.oidc.claims, emailVerified: true };
  assert.equal(await code(oidcLogin(h)), 'oidc_link_required');
  assert.equal((await h.ctx.db.query('SELECT count(*)::int n FROM oidc_identities')).rows[0].n, 0);
}));

test('OIDC: linking from a signed-in session, owner only, and removal guard', { skip }, () => using({ registration: 'open' }, async (h) => {
  const a = await signUp(h, 'a@example.test');
  const b = await signUp(h, 'b@example.test');
  const pa = await principalFor(h, a.session.token);
  const pb = await principalFor(h, b.session.token);
  // B's browser cannot complete a link that A started.
  const st = await oidc.start(h.ctx, { mode: 'link', principal: pa }, meta);
  const state = new URL(st.url).searchParams.get('state')!;
  assert.equal(await code(oidc.callback(h.ctx, { query: new URLSearchParams({ state }), binding: st.binding, principal: pb }, meta)), 'forbidden');
  assert.equal(await code(oidcLogin(h, { mode: 'link', principal: pa })), 'no_error');
  // Now the identity signs in as A, and B cannot claim it.
  const login = await oidcLogin(h);
  assert.equal(login.kind === 'login' && login.signIn.userId, pa.userId);
  assert.equal(await code(oidcLogin(h, { mode: 'link', principal: pb })), 'oidc_already_linked');
  // A may drop the password because OIDC remains, but then not the OIDC identity.
  await acct.removePassword(h.ctx, pa);
  const ident = (await h.ctx.db.query('SELECT id FROM oidc_identities')).rows[0].id;
  assert.equal(await code(oidc.unlink(h.ctx, pa, ident)), 'last_credential');
}));

test('OIDC: closed registration blocks new accounts after bootstrap', { skip }, () => using({ registration: 'closed' }, async (h) => {
  await signUp(h, 'admin@example.test');
  assert.equal(await code(oidcLogin(h)), 'registration_closed');
}));
