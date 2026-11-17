// Regression tests for the fixes from the 2026-11-12 security review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, parseCookies, type Route } from '../src/http/app.ts';
import { HttpProblem } from '../src/http/problem.ts';
import { requirePrincipal } from '../src/identity.ts';
import { uuidv7 } from '../src/ids.ts';
import { stripImageMetadata } from '../src/vehicles/image-metadata.ts';
import * as acct from '../src/auth/accounts.ts';
import * as oidc from '../src/auth/oidc.ts';
import { fakeAuthenticator, noProxies, ORIGIN, type TestUser } from './helpers/index.ts';
import { currentTotp, harness, meta, principalFor, signUp, type Harness } from './helpers/auth.ts';
import { exif, JFIF, jpeg, jpegSegment, png, pngChunk, webp, webpChunk } from './helpers/images.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof HttpProblem) return e.code; throw e; }
  return 'no_error';
}
async function using<T>(over: Parameters<typeof harness>[0], fn: (h: Harness) => Promise<T>) {
  const h = (await harness(over))!;
  try { return await fn(h); } finally { await h.drop(); }
}
const has = (b: Buffer, s: string) => b.includes(Buffer.from(s, 'latin1'));

// ---- photo metadata ----

test('JPEG: EXIF, XMP and comments are removed, orientation is kept, image data untouched', () => {
  const xmp = jpegSegment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPSLatitude</x:xmpmeta>', 'latin1'));
  const comment = jpegSegment(0xfe, Buffer.from('taken at home', 'latin1'));
  const icc = jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1'));
  const input = jpeg(JFIF, exif(6), xmp, comment, icc);
  const out = stripImageMetadata(input, 'image/jpeg')!;
  assert.ok(out);
  for (const s of ['GPS', 'Cam', 'xmpmeta', 'taken at home']) assert.ok(!has(out, s), `${s} removed`);
  assert.ok(has(out, 'JFIF') && has(out, 'ICC_PROFILE'), 'colour information kept');
  // A single EXIF field remains: Orientation 6, big-endian.
  const at = out.indexOf(Buffer.from('Exif\0\0MM', 'latin1'));
  assert.ok(at > 0);
  assert.equal(out.readUInt16BE(at + 6 + 10), 0x0112);
  assert.equal(out.readUInt16BE(at + 6 + 18), 6);
  assert.ok(out.subarray(out.length - 34).equals(input.subarray(input.length - 34)), 'scan data and EOI unchanged');
  // Normal orientation needs no EXIF at all, and a clean file comes back byte for byte.
  assert.ok(!has(stripImageMetadata(jpeg(JFIF, exif(1)), 'image/jpeg')!, 'Exif'));
  const clean = jpeg(JFIF);
  assert.ok(stripImageMetadata(clean, 'image/jpeg')!.equals(clean));
});

test('PNG and WebP: text and EXIF chunks are removed', () => {
  const p = png(pngChunk('tEXt', Buffer.from('Comment\0secret', 'latin1')), pngChunk('eXIf', Buffer.from('MM\0*GPS', 'latin1')), pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0GPS', 'latin1')));
  const po = stripImageMetadata(p, 'image/png')!;
  assert.ok(!has(po, 'secret') && !has(po, 'GPS') && has(po, 'IHDR') && has(po, 'IDAT') && has(po, 'IEND'));
  assert.ok(stripImageMetadata(png(), 'image/png')!.equals(png()));

  const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c; // EXIF and XMP flags set
  const w = webp(webpChunk('VP8X', vp8x), webpChunk('VP8 ', Buffer.alloc(21, 4)), webpChunk('EXIF', Buffer.from('MM\0*GPS', 'latin1')), webpChunk('XMP ', Buffer.from('<x>GPS</x>', 'latin1')));
  const wo = stripImageMetadata(w, 'image/webp')!;
  assert.ok(!has(wo, 'GPS') && !has(wo, 'EXIF') && !has(wo, 'XMP '));
  assert.equal(wo.readUInt32LE(4), wo.length - 8, 'RIFF size matches');
  assert.equal(wo[20]! & 0x0c, 0, 'VP8X flags cleared');
});

test('damaged images are refused rather than stored', () => {
  assert.equal(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]), 'image/jpeg'), null);
  assert.equal(stripImageMetadata(Buffer.concat([png().subarray(0, 8), Buffer.from([0, 0, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52])]), 'image/png'), null);
  assert.equal(stripImageMetadata(webp(Buffer.from('VP8 \xff\xff\xff\x00', 'latin1')), 'image/webp'), null);
});

// ---- malformed percent-encoding ----

test('a malformed cookie or path parameter does not fail the request', async () => {
  assert.deepEqual(parseCookies('other=%E0%A4%A; dl_session=abc'), { other: '%E0%A4%A', dl_session: 'abc' });
  const id = uuidv7();
  const principal = { userId: id, sessionId: uuidv7(), instanceRole: 'user' as const, authenticatedAt: new Date() };
  const user: TestUser = { id, email: 'a@example.test', role: 'user', principal, ctx: { principal } };
  const routes: Route[] = [
    { method: 'GET', path: '/v1/whoami', handler: async (r) => ({ status: 200, body: { id: requirePrincipal(r.ctx).userId } }) },
    { method: 'GET', path: '/v1/things/:id', auth: 'none', handler: async (r) => ({ status: 200, body: { id: r.params['id'] } }) },
  ];
  const server = createServer(createApp({ routes, authenticator: fakeAuthenticator([user]), publicOrigin: ORIGIN, ipTrust: noProxies }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const me = await fetch(`${base}/v1/whoami`, { headers: { cookie: `tracker=50%; dl_session=${id}` } });
    assert.equal(me.status, 200, 'another cookie on the host cannot break the API');
    assert.equal((await fetch(`${base}/v1/things/%E0%A4%A`)).status, 404);
  } finally { server.close(); }
});

// ---- accounts ----

test('registration is refused when password sign-in is disabled', { skip }, () => using({ passwordEnabled: false, registration: 'open' }, async (h) => {
  assert.equal(await code(acct.register(h.ctx, { email: 'a@example.test', password: 'correct horse battery staple' }, meta)), 'password_login_disabled');
  assert.equal((await h.ctx.db.query('SELECT count(*)::int n FROM users')).rows[0].n, 0);
}));

test('enabling an authenticator app signs out every other session', { skip }, () => using({}, async (h) => {
  const s = await signUp(h, 'a@example.test');
  const other = await acct.login(h.ctx, { email: 'a@example.test', password: 'correct horse battery staple' }, meta);
  const p = await principalFor(h, s.session.token);
  const begin = await acct.totpBegin(h.ctx, p);
  await acct.totpConfirm(h.ctx, p, await currentTotp(h, begin.secret));
  assert.ok(await h.auth.resolveSession(s.session.token), 'the enrolling session stays');
  assert.equal(await h.auth.resolveSession(other.session.token), null, 'older sessions are revoked');
}));

// ---- OIDC bootstrap ----

async function oidcBootstrap(h: Harness, setupToken?: string) {
  const st = await oidc.start(h.ctx, { mode: 'login', principal: null, setupToken }, meta);
  const state = new URL(st.url).searchParams.get('state')!;
  return oidc.callback(h.ctx, { query: new URLSearchParams({ code: 'abc', state }), binding: st.binding, principal: null }, meta);
}

test('OIDC cannot create the first account without the setup token', { skip }, () => using({ registration: 'closed', setupToken: 'a-long-setup-token-value' }, async (h) => {
  assert.equal(await code(oidcBootstrap(h)), 'setup_token_required');
  assert.equal(await code(oidcBootstrap(h, 'wrong-token-value')), 'setup_token_required');
  assert.equal((await h.ctx.db.query('SELECT count(*)::int n FROM users')).rows[0].n, 0);
  const ok = await oidcBootstrap(h, 'a-long-setup-token-value');
  assert.equal(ok.kind, 'login');
  assert.equal((await h.ctx.db.query("SELECT instance_role FROM users")).rows[0].instance_role, 'admin');
  // Once an account exists, the token plays no part and closed registration applies.
  h.oidc.claims = { ...h.oidc.claims, subject: 'sub-2', email: 'second@example.test' };
  assert.equal(await code(oidcBootstrap(h, 'a-long-setup-token-value')), 'registration_closed');
}));

test('OIDC bootstrap without a configured setup token is unchanged', { skip }, () => using({ registration: 'closed' }, async (h) => {
  assert.equal((await oidcBootstrap(h)).kind, 'login');
}));
