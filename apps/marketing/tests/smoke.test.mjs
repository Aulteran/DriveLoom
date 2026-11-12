import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
const html = existsSync(join(root, 'dist/index.html')) ? readFileSync(join(root, 'dist/index.html'), 'utf8') : '';
const live = process.env.SMOKE_URL;

test('built page has semantic landmarks', () => {
  assert.ok(html, 'run npm run build first');
  for (const re of [/<html lang="[^"]+"/, /<main id="main">/, /<h1[^>]*>[\s\S]+?<\/h1>/, /<header[ >]/, /<footer[ >]/])
    assert.match(html, re);
});

test('identity comes from site.config.json', () => {
  assert.ok(html.includes(`<title>${cfg.name}</title>`));
});

test('no analytics, tracking, forms or third-party scripts', () => {
  assert.doesNotMatch(html, /<form|<iframe|google-analytics|gtag|plausible|umami|matomo|segment\.com/i);
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]);
  assert.deepEqual(scripts, [`<script src="${cfg.basePath}demo.js" defer></script>`], 'only the same-origin demo script');
});

test('demo script stays offline: no network, storage or cookies', () => {
  const js = readFileSync(join(root, 'dist/demo.js'), 'utf8');
  assert.doesNotMatch(js, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test('every bundled asset is in the asset register', () => {
  const register = readFileSync(join(root, 'ASSET-PROVENANCE.md'), 'utf8');
  const code = new Set(['index.html', 'styles.css', 'demo.js']);
  const walk = (d, pre = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
  for (const f of walk(join(root, 'src')).filter((f) => !code.has(f)))
    assert.ok(register.includes(`src/${f}`), `src/${f} is missing from ASSET-PROVENANCE.md`);
});

test('self-hosted fonts ship with their licences', () => {
  for (const f of ['fonts/space-grotesk-latin-wght-normal.woff2', 'fonts/jetbrains-mono-latin-wght-normal.woff2', 'fonts/OFL-SpaceGrotesk.txt', 'fonts/OFL-JetBrainsMono.txt'])
    assert.ok(existsSync(join(root, 'dist', f)), f);
  assert.ok(html.includes(`href="${cfg.basePath}fonts/space-grotesk-latin-wght-normal.woff2"`), 'display font is preloaded under the base path');
});

test('copy makes no claims about untested or unbuilt features', () => {
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, /\bOIDC\b|single sign-on|\bSSO\b|works offline|offline mode|available on (the )?(App Store|Google Play)|download the app/i);
});

test('asset links use the configured base path', () => {
  assert.ok(html.includes(`href="${cfg.basePath}styles.css"`));
  assert.ok(html.includes(`src="${cfg.basePath}demo.js"`));
  assert.ok(html.includes(`href="${cfg.basePath}icon.svg"`));
});

test('share image meta tags point at the absolute og-image URL', () => {
  assert.ok(html.includes(`property="og:image" content="${cfg.siteUrl}og-image.png"`));
  assert.ok(html.includes(`name="twitter:image" content="${cfg.siteUrl}og-image.png"`));
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.ok(existsSync(join(root, 'dist/og-image.png')));
});

test('live URL responds (only when SMOKE_URL is set)', { skip: !live }, async () => {
  const res = await fetch(live);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes(`<title>${cfg.name}</title>`));
});
