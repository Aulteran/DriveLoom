// PWA plumbing: the service worker and manifest are served correctly, the worker's
// build id is a content hash of the web files, the precache never names the API,
// and the icon files the manifest promises exist at the sizes it claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServiceWorker, staticFiles } from '../src/http/static.ts';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));

async function serve<T>(dir: string, fn: (get: (p: string) => Promise<Response>) => Promise<T>): Promise<T> {
  const handler = staticFiles(dir, { secure: false });
  const server = createServer((q, s) => void handler(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { return await fn((p) => fetch(base + p)); } finally { server.close(); server.closeAllConnections(); }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-web-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}
const SW = readFileSync(`${WEB}sw.js`, 'utf8');
const buildOf = (source: string) => /const BUILD = "([0-9a-f]+)"/.exec(source)?.[1];

test('sw.js is served fresh, as JavaScript, with the build id and precache injected', async () => {
  await serve(WEB, async (get) => {
    const res = await get('/sw.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/);
    const body = await res.text();
    assert.match(buildOf(body) ?? '', /^[0-9a-f]{16}$/);
    assert.ok(!body.includes('__BUILD__') && !body.includes('/*PRECACHE*/'));
  });
});

test('manifest is served no-cache with the manifest type', async () => {
  await serve(WEB, async (get) => {
    const res = await get('/manifest.webmanifest');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^application\/manifest\+json/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
});

test('the build id is stable for identical files and changes when a file changes', async () => {
  const files = { 'sw.js': SW, 'index.html': '<p>a</p>', 'js/app.js': 'export {};' };
  const a = fixture(files), b = fixture(files);
  try {
    const [ida, idb] = [a, b].map((d) => buildOf(buildServiceWorker(d)!.source));
    assert.ok(ida);
    assert.equal(ida, idb);
    // Two servers over the same files hand out the same worker, byte for byte.
    const [bodyA, bodyB] = [await serve(a, (g) => g('/sw.js').then((r) => r.text())), await serve(b, (g) => g('/sw.js').then((r) => r.text()))];
    assert.equal(bodyA, bodyB);
    writeFileSync(path.join(b, 'js/app.js'), 'export const x = 1;');
    assert.notEqual(buildOf(buildServiceWorker(b)!.source), ida);
    // A renamed file changes it too: the hash covers paths as well as bytes.
    rmSync(path.join(a, 'js/app.js'));
    writeFileSync(path.join(a, 'js/other.js'), 'export {};');
    assert.notEqual(buildOf(buildServiceWorker(a)!.source), ida);
  } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test('the precache is the static shell only: no API, no worker, no licence texts', () => {
  const { precache } = buildServiceWorker(WEB)!;
  assert.ok(precache.includes('/'), 'index.html is precached as /');
  for (const need of ['/styles.css', '/mobile.css', '/js/boot.js', '/js/pwa.js', '/icons/icon-192.png', '/manifest.webmanifest']) assert.ok(precache.includes(need), need);
  assert.ok(precache.some((p) => p.startsWith('/fonts/') && p.endsWith('.woff2')));
  assert.ok(!precache.some((p) => p.includes('/v1/') || p === '/sw.js' || p.endsWith('.txt')), precache.join(' '));
  assert.equal(new Set(precache).size, precache.length);
});

test('without a sw.js nothing is injected, and traversal stays blocked', async () => {
  const dir = fixture({ 'index.html': '<p>x</p>' });
  try {
    assert.equal(buildServiceWorker(dir), null);
    await serve(dir, async (get) => {
      assert.equal((await get('/sw.js')).status, 404);
      assert.ok(!(await (await get('/%2e%2e/%2e%2e/etc/passwd')).text()).includes('root:'));
      assert.equal((await get('/%2e%2e/%2e%2e/etc/hostname.txt')).status, 404);
    });
  } finally { rmSync(dir, { recursive: true }); }
});

test('the worker source is network-first for the shell and bypasses the API and non-GET requests', () => {
  // A secondary guard on the source; the browser test proves the behaviour (no /v1 request in any cache).
  assert.ok(/pathname\.startsWith\('\/v1\/'\)/.test(SW), 'API paths are passed through');
  assert.ok(/req\.method !== 'GET'/.test(SW), 'non-GET passes through');
  assert.ok(!/skipWaiting\(\)/.test(SW.replace(/if \(type === 'SKIP_WAITING'\) self\.skipWaiting\(\);/, '')), 'skipWaiting only on the message');
  assert.ok(/cache: 'reload'/.test(SW), 'precache bypasses the HTTP cache');
  assert.ok(/fetch\(req, \{ cache: 'no-cache' \}\)/.test(SW), 'the shell is fetched revalidated, network first');
  assert.ok(!/caches\.match\([^)]*\)\s*\|\|\s*fetch/.test(SW), 'no cache-first lookup before the network');
  assert.ok(/res\.status === 200 && res\.type === 'basic'/.test(SW), 'only plain 200 responses refresh the cache');
  // Sign-out keeps the (static) shell caches so an offline cold start still works.
  const clear = /const clearAll = [^\n]*/.exec(SW)?.[0] ?? '';
  assert.ok(/startsWith\('driveloom-shell-'\)/.test(clear) && /!key\.startsWith/.test(clear), clear);
  assert.ok(/!key\.startsWith\('driveloom-shell-'\)/.test(readFileSync(`${WEB}js/pwa.js`, 'utf8')), 'pwa.js keeps the shell caches too');
});

test('file names with replacement patterns in them are injected literally', () => {
  const dir = fixture({ 'sw.js': SW, 'index.html': '<p>a</p>', 'js/a$&b$1.js': 'export {};' });
  try {
    const { source, precache } = buildServiceWorker(dir)!;
    assert.ok(precache.includes('/js/a%24&b%241.js') || precache.includes('/js/a$&b$1.js'), precache.join(' '));
    assert.ok(source.includes(JSON.stringify(precache)), 'precache list injected verbatim');
    assert.ok(!source.includes('/*PRECACHE*/') && !source.includes('__BUILD__'));
  } finally { rmSync(dir, { recursive: true }); }
});

interface Icon { src: string; sizes: string; type: string; purpose?: string }
const pngSize = (file: string) => { const b = readFileSync(file); assert.equal(b.subarray(1, 4).toString(), 'PNG'); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`; };

test('the manifest is installable and every icon exists at the size it claims', () => {
  const m = JSON.parse(readFileSync(`${WEB}manifest.webmanifest`, 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.id, '/');
  assert.ok(m.name && m.short_name && m.lang && m.theme_color && m.background_color);
  const icons: Icon[] = m.icons;
  assert.ok(icons.some((i) => i.sizes === '192x192' && i.type === 'image/png'));
  assert.ok(icons.some((i) => i.sizes === '512x512' && i.type === 'image/png' && (i.purpose ?? 'any') === 'any'));
  assert.ok(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  for (const i of icons) {
    const file = path.join(WEB, i.src);
    assert.ok(existsSync(file), i.src);
    if (i.type === 'image/png') assert.equal(pngSize(file), i.sizes, i.src);
  }
});

test('the apple-touch-icon is a 180x180 PNG and index.html links it', () => {
  assert.equal(pngSize(`${WEB}icons/apple-touch-icon.png`), '180x180');
  const index = readFileSync(`${WEB}index.html`, 'utf8');
  assert.match(index, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
  assert.match(index, /apple-mobile-web-app-capable/);
});
