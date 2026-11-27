// The API contract and the self-hosted docs are public static files: right type, the validated file's content,
// version-matched, never the client's index.html. No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { staticFiles, buildServiceWorker } from '../src/http/static.ts';
import { isOpenApiPath, openApiHandler } from '../src/http/openapi-docs.ts';
import { API_VERSION } from '../src/version.ts';
import { SUPPORTED_LEVELS } from '../src/auth/api-key-policy.ts';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const SPEC = fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url));

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const web = staticFiles(WEB, { secure: false });
  const spec = openApiHandler({ secure: false });
  const server = createServer((req, res) => { void ((isOpenApiPath((req.url ?? '/').split('?')[0]!) ? spec : web)(req, res)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); server.closeAllConnections(); }
}

test('/openapi.yaml is the validated contract file, version-matched, with a YAML type', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/openapi.yaml`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^application\/yaml; charset=utf-8$/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const text = await r.text();
    assert.equal(text, readFileSync(SPEC, 'utf8'), 'byte-for-byte the file the build validates');
    assert.equal((parse(text) as { info: { version: string } }).info.version, API_VERSION);
    assert.equal((await fetch(`${base}/openapi.yaml`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${base}/openapi.yaml`, { method: 'POST' })).status, 405);
  });
});

test('/openapi.json is the same document as JSON', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/openapi.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
    const doc = await r.json() as { info: { version: string }; paths: Record<string, unknown> };
    assert.deepEqual(doc, parse(readFileSync(SPEC, 'utf8')));
    assert.equal(doc.info.version, API_VERSION);
    assert.ok(doc.paths['/v1/auth/api-keys']);
  });
});

test('/docs is its own page with the strict CSP, never the client shell', async () => {
  await withServer(async (base) => {
    for (const p of ['/docs', '/docs/']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
      const html = await r.text();
      assert.match(html, /<title>API documentation/);
      assert.ok(!html.includes('id="app"') && !html.includes('/js/boot.js'), 'not the SPA shell');
      assert.match(r.headers.get('content-security-policy') ?? '', /script-src 'self'; style-src 'self'/);
      assert.ok(!/<script(?![^>]*\bsrc=)/.test(html) && !/\sstyle=|\son[a-z]+=/i.test(html), 'no inline script, style or handler');
      assert.ok(!/https?:\/\//.test(html.replace(/<html[^>]*>/, '')), 'no third-party URL in the page');
    }
    for (const p of ['/docs/docs.js', '/docs/docs.css']) assert.equal((await fetch(`${base}${p}`)).status, 200, p);
    assert.equal((await fetch(`${base}/docs/nothing.js`)).status, 404);
    const js = await (await fetch(`${base}/docs/docs.js`)).text();
    assert.ok(!/https?:\/\//.test(js.replace(/\/\/.*$/gm, '')), 'the docs script never names a third-party host');
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js), 'the docs never persist anything');
  });
});

test('the docs are not part of the precached app shell', () => {
  const sw = buildServiceWorker(WEB)!;
  assert.ok(sw.precache.includes('/') && sw.precache.includes('/js/api-keys.js'));
  assert.deepEqual(sw.precache.filter((p) => p.startsWith('/docs') || p.startsWith('/openapi')), []);
  const swSource = readFileSync(`${WEB}sw.js`, 'utf8');
  assert.match(swSource, /\/docs/);
  assert.match(swSource, /startsWith\('\/v1\/'\)/);
});

test('the web client offers exactly the levels the server supports for each module', async () => {
  const mod = await import(`${WEB}js/api-keys.js`) as { MODULES: { id: string; levels: string[] }[] };
  const ui = Object.fromEntries(mod.MODULES.map((m) => [m.id, m.levels]));
  assert.deepEqual(ui, Object.fromEntries(Object.entries(SUPPORTED_LEVELS).map(([k, v]) => [k, [...v]])));
});
