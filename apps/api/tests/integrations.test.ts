import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.ts';
import { authRoutes } from '../src/auth/routes.ts';
import { adminRoutes } from '../src/admin/routes.ts';
import { Integrations } from '../src/admin/integrations.ts';
import { uuidv7 } from '../src/ids.ts';
import { ORIGIN } from './helpers/index.ts';
import { harness, PW, type Harness } from './helpers/auth.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
type Res = { status: number; json: any };
interface Client { (method: string, path: string, body?: unknown): Promise<Res> }

async function world(opts: Parameters<typeof harness>[1], fn: (w: { h: Harness; admin: Client; user: Client; anon: Client }) => Promise<void>, over: Parameters<typeof harness>[0] = {}) {
  const h = (await harness(over, { integrations: true, ...opts }))!;
  const server = createServer((q, s) => void createApp({ routes: [...authRoutes(h.ctx), ...adminRoutes(h.ctx)], authenticator: h.auth, publicOrigin: ORIGIN, ipTrust: h.ctx.config.ipTrust })(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (cookie = '', csrf = ''): Client => async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const signUp = async (email: string) => {
    assert.equal((await client()('POST', '/v1/auth/register', { email, password: PW })).status, 202);
    const res = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    return client(res.headers.getSetCookie()[0]!.split(';')[0]!, ((await res.json()) as { csrf_token: string }).csrf_token);
  };
  try { const admin = await signUp('admin@example.test'); const user = await signUp('user@example.test'); await fn({ h, admin, user, anon: client() }); }
  finally { server.close(); server.closeAllConnections(); await h.drop(); }
}

const SMTP = { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', password: 'hunter2-smtp-secret', from: 'DriveLoom <noreply@example.test>' };

test('SMTP settings apply live, keep the password write-only and can be tested and removed', { skip }, () => world({}, async ({ h, admin, user, anon }) => {
  assert.equal((await user('GET', '/v1/admin/settings/smtp')).status, 403);
  const none = (await admin('GET', '/v1/admin/settings/smtp')).json;
  assert.equal(none.source, 'none'); assert.equal(none.configured, false);
  assert.equal((await anon('GET', '/v1/auth/instance')).json.email_recovery, false);

  const saved = await admin('PUT', '/v1/admin/settings/smtp', SMTP);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.deepEqual(saved.json, { source: 'database', enabled: true, configured: true, host: SMTP.host, port: 587, security: 'starttls', username: 'mailer', from: SMTP.from, hasPassword: true, secretUnreadable: false });
  assert.ok(!JSON.stringify(saved.json).includes(SMTP.password));
  assert.equal((await anon('GET', '/v1/auth/instance')).json.email_recovery, true, 'recovery turns on without a restart');
  const row = (await h.ctx.db.query('SELECT config, secret_enc FROM integration_settings WHERE kind = $1', ['smtp'])).rows[0]!;
  assert.ok(!JSON.stringify(row).includes(SMTP.password), 'the password is encrypted at rest');

  // Omitting the password keeps it; the stored value still decrypts.
  const { password: _p, ...noPassword } = SMTP;
  assert.equal((await admin('PUT', '/v1/admin/settings/smtp', { ...noPassword, port: 465, security: 'tls' })).json.hasPassword, true);
  assert.equal((await admin('PUT', '/v1/admin/settings/smtp', { ...noPassword, password: null })).json.hasPassword, false);
  await admin('PUT', '/v1/admin/settings/smtp', SMTP);

  const test = await admin('POST', '/v1/admin/settings/smtp/test');
  assert.equal(test.status, 200); assert.equal(test.json.sentTo, 'admin@example.test');
  assert.equal(h.mailer.sent.at(-1)!.to, 'admin@example.test');
  h.mailer.fail = true;
  const failed = await admin('POST', '/v1/admin/settings/smtp/test');
  assert.equal(failed.status, 502); assert.equal(failed.json.code, 'smtp_test_failed'); assert.match(failed.json.detail, /smtp down/);
  h.mailer.fail = false;

  for (const bad of [{ ...SMTP, host: 'bad host' }, { ...SMTP, port: 0 }, { ...SMTP, security: 'ssl' }, { ...SMTP, from: 'not an address' }, { ...SMTP, from: 'a@example.test\r\nBcc: x@example.test' }, { ...SMTP, extra: 1 }]) {
    assert.equal((await admin('PUT', '/v1/admin/settings/smtp', bad)).status, 422, JSON.stringify(bad));
  }

  const audit = (await h.ctx.db.query("SELECT details FROM audit_events WHERE action LIKE 'admin.smtp_%'")).rows;
  assert.ok(audit.length >= 4); assert.ok(!JSON.stringify(audit).includes(SMTP.password));

  assert.equal((await admin('DELETE', '/v1/admin/settings/smtp')).status, 204);
  assert.equal(h.ctx.mailer, null);
  assert.equal((await anon('GET', '/v1/auth/instance')).json.email_recovery, false);
}));

test('changes need a recent sign-in', { skip }, () => world({}, async ({ h, admin }) => {
  h.clock.t += h.ctx.config.reauthWindowMs + 1000;
  for (const [m, p, b] of [['PUT', 'smtp', SMTP], ['DELETE', 'smtp'], ['POST', 'smtp/test'], ['PUT', 'oidc', { issuer: 'https://idp.test', clientId: 'a', clientSecret: 'b' }], ['DELETE', 'oidc'], ['POST', 'oidc/test']] as const) {
    const r = await admin(m, `/v1/admin/settings/${p}`, b);
    assert.equal(r.json.code, 'reauth_required', `${m} ${p}`);
  }
}));

test('SMTP guards: email features that need it block removal', { skip }, () => world({}, async ({ h, admin }) => {
  await admin('PUT', '/v1/admin/settings/smtp', SMTP);
  (h.ctx.config as { emailSignInCodes: boolean }).emailSignInCodes = true;
  const r = await admin('DELETE', '/v1/admin/settings/smtp');
  assert.equal(r.status, 409); assert.equal(r.json.code, 'email_features_enabled');
  assert.ok(h.ctx.mailer);
}));

test('OIDC settings apply live, hide the secret and can be tested', { skip }, () => world({}, async ({ h, admin, anon }) => {
  const empty = (await admin('GET', '/v1/admin/settings/oidc')).json;
  assert.deepEqual(empty, { source: 'none', enabled: true, configured: false, issuer: '', clientId: '', hasClientSecret: false, secretUnreadable: false, redirectUri: `${ORIGIN}/v1/auth/oidc/callback` });
  assert.equal((await anon('GET', '/v1/auth/instance')).json.oidc, false);
  const body = { issuer: 'https://idp.test', clientId: 'driveloom', clientSecret: 'oidc-client-secret-value' };
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { ...body, clientSecret: undefined })).status, 422, 'a first save needs the secret');
  const saved = await admin('PUT', '/v1/admin/settings/oidc', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.hasClientSecret, true); assert.ok(!JSON.stringify(saved.json).includes(body.clientSecret));
  assert.equal((await anon('GET', '/v1/auth/instance')).json.oidc, true);
  assert.ok(!JSON.stringify((await h.ctx.db.query('SELECT * FROM integration_settings')).rows).includes(body.clientSecret));
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { issuer: 'https://idp.test', clientId: 'renamed' })).json.hasClientSecret, true, 'blank secret keeps the stored one');
  const probe = await admin('POST', '/v1/admin/settings/oidc/test');
  assert.deepEqual(probe.json, { issuer: 'https://idp.test', authorizationEndpoint: 'https://idp.test/auth' });
  for (const bad of ['http://idp.test', 'https://idp.test/?x=1', 'not a url']) assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { ...body, issuer: bad })).status, 422, bad);
  assert.equal((await admin('DELETE', '/v1/admin/settings/oidc')).status, 204);
  assert.equal(h.ctx.oidc, null);
}));

test('OIDC guards: lockout and stranded accounts', { skip }, () => world({}, async ({ h, admin }) => {
  const body = { issuer: 'https://idp.test', clientId: 'driveloom', clientSecret: 'secret' };
  await admin('PUT', '/v1/admin/settings/oidc', body);
  (h.ctx.config as { passwordEnabled: boolean }).passwordEnabled = false;
  assert.equal((await admin('DELETE', '/v1/admin/settings/oidc')).json.code, 'password_login_disabled');
  (h.ctx.config as { passwordEnabled: boolean }).passwordEnabled = true;

  // An account that signs in only through the provider.
  const uid = (await h.ctx.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'user@example.test'")).rows[0]!.id;
  await h.ctx.db.query('DELETE FROM password_credentials WHERE user_id = $1', [uid]);
  await h.ctx.db.query('INSERT INTO oidc_identities (id, user_id, issuer, subject) VALUES ($1,$2,$3,$4)', [uuidv7(), uid, 'https://idp.test', 'sub']);
  assert.equal((await admin('DELETE', '/v1/admin/settings/oidc')).json.code, 'oidc_identities_in_use');
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { ...body, issuer: 'https://other.test' })).json.code, 'oidc_identities_in_use');
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { ...body, issuer: 'https://idp.test/', clientId: 'x' })).status, 200, 'a trailing slash is the same issuer');
}));

test('environment settings win and the pages become read-only', { skip }, () => world({ integrationEnv: { smtp: { url: 'smtp://user:pw@smtp.env.test:25', from: 'env@example.test' }, oidc: { issuer: 'https://env.idp.test', clientId: 'env-client', clientSecret: 'env-secret', redirectUri: `${ORIGIN}/v1/auth/oidc/callback` } } }, async ({ h, admin }) => {
  const smtp = (await admin('GET', '/v1/admin/settings/smtp')).json;
  assert.equal(smtp.source, 'env'); assert.equal(smtp.from, 'env@example.test'); assert.ok(!JSON.stringify(smtp).includes('pw'));
  const oidc = (await admin('GET', '/v1/admin/settings/oidc')).json;
  assert.equal(oidc.source, 'env'); assert.equal(oidc.issuer, 'https://env.idp.test'); assert.ok(!JSON.stringify(oidc).includes('env-secret'));
  for (const [m, p, b] of [['PUT', 'smtp', SMTP], ['DELETE', 'smtp'], ['PUT', 'oidc', { issuer: 'https://idp.test', clientId: 'a', clientSecret: 'b' }], ['DELETE', 'oidc']] as const) {
    const r = await admin(m, `/v1/admin/settings/${p}`, b);
    assert.equal(r.json.code, 'managed_by_environment', `${m} ${p}`);
  }
  assert.ok(h.ctx.mailer && h.ctx.oidc);
}));

test('a saved secret that this instance key cannot open is reported, not fatal', { skip }, () => world({}, async ({ h, admin }) => {
  await admin('PUT', '/v1/admin/settings/smtp', SMTP);
  await admin('PUT', '/v1/admin/settings/oidc', { issuer: 'https://idp.test', clientId: 'c', clientSecret: 's' });
  const other = new Integrations(h.ctx.db, Buffer.alloc(32, 9), ORIGIN, { smtp: null, oidc: null }, { mailer: () => h.mailer, oidc: () => h.oidc });
  await other.load();
  assert.equal(other.mailer, null); assert.equal(other.oidc, null);
  assert.equal(other.smtpView().secretUnreadable, true); assert.equal(other.oidcView().secretUnreadable, true);
  assert.equal(other.smtpView().host, SMTP.host, 'non-secret fields survive');
  // Re-entering the secret repairs it.
  await other.saveOidc({ settings: { issuer: 'https://idp.test', clientId: 'c' }, clientSecret: 'fresh', enabled: undefined });
  assert.ok(other.oidc && !other.oidcView().secretUnreadable);
}));

test('the enable switch keeps saved fields while the feature is off', { skip }, () => world({}, async ({ h, admin, anon }) => {
  // Save SMTP switched off on the first save: stored, but not in use.
  const off = await admin('PUT', '/v1/admin/settings/smtp', { ...SMTP, enabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.enabled, false); assert.equal(off.json.configured, false); assert.equal(off.json.hasPassword, true); assert.equal(off.json.host, SMTP.host);
  assert.equal(h.ctx.mailer, null);
  assert.equal((await anon('GET', '/v1/auth/instance')).json.email_recovery, false);
  assert.equal((await admin('POST', '/v1/admin/settings/smtp/test')).json.code, 'smtp_not_configured');
  // Turning it on needs no re-entry; the saved password is kept.
  const on = await admin('PUT', '/v1/admin/settings/smtp', { host: SMTP.host, port: 587, security: 'starttls', username: 'mailer', from: SMTP.from, enabled: true });
  assert.equal(on.json.enabled, true); assert.equal(on.json.configured, true); assert.equal(on.json.hasPassword, true);
  assert.ok(h.ctx.mailer);
  // Omitting `enabled` keeps the state.
  await admin('PUT', '/v1/admin/settings/smtp', { ...SMTP, enabled: false });
  assert.equal((await admin('PUT', '/v1/admin/settings/smtp', { host: 'other.example.test', port: 25, security: 'none', from: SMTP.from })).json.enabled, false);
  assert.equal((await admin('PUT', '/v1/admin/settings/smtp', { ...SMTP, enabled: 'yes' })).status, 422);
  // The state survives a restart.
  const again = new Integrations(h.ctx.db, h.ctx.config.secretKey, ORIGIN, { smtp: null, oidc: null }, { mailer: () => h.mailer, oidc: () => h.oidc });
  await again.load();
  assert.equal(again.mailer, null); assert.equal(again.smtpView().enabled, false);

  // OIDC the same way.
  const body = { issuer: 'https://idp.test', clientId: 'driveloom', clientSecret: 'secret' };
  const o = await admin('PUT', '/v1/admin/settings/oidc', { ...body, enabled: false });
  assert.equal(o.json.enabled, false); assert.equal(o.json.configured, false); assert.equal(o.json.hasClientSecret, true);
  assert.equal(h.ctx.oidc, null);
  assert.equal((await anon('GET', '/v1/auth/instance')).json.oidc, false);
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { issuer: body.issuer, clientId: body.clientId, enabled: true })).json.configured, true);
  assert.ok(h.ctx.oidc);
}));

test('turning a feature off is refused under the same guards as removing it', { skip }, () => world({}, async ({ h, admin }) => {
  await admin('PUT', '/v1/admin/settings/smtp', SMTP);
  (h.ctx.config as { emailSignInCodes: boolean }).emailSignInCodes = true;
  assert.equal((await admin('PUT', '/v1/admin/settings/smtp', { ...SMTP, enabled: false })).json.code, 'email_features_enabled');
  assert.ok(h.ctx.mailer);
  (h.ctx.config as { emailSignInCodes: boolean }).emailSignInCodes = false;

  const body = { issuer: 'https://idp.test', clientId: 'driveloom', clientSecret: 'secret' };
  await admin('PUT', '/v1/admin/settings/oidc', body);
  const uid = (await h.ctx.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'user@example.test'")).rows[0]!.id;
  await h.ctx.db.query('DELETE FROM password_credentials WHERE user_id = $1', [uid]);
  await h.ctx.db.query('INSERT INTO oidc_identities (id, user_id, issuer, subject) VALUES ($1,$2,$3,$4)', [uuidv7(), uid, 'https://idp.test', 'sub']);
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { ...body, enabled: false })).json.code, 'oidc_identities_in_use');
  assert.ok(h.ctx.oidc);
  (h.ctx.config as { passwordEnabled: boolean }).passwordEnabled = false;
  await h.ctx.db.query('DELETE FROM oidc_identities'); // no stranded accounts, but password sign-in is off
  assert.equal((await admin('PUT', '/v1/admin/settings/oidc', { ...body, enabled: false })).json.code, 'password_login_disabled');
}));
