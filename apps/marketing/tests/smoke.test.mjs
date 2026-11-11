import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'site.config.json'), 'utf8'));
const html = existsSync(join(root, 'dist/index.html')) ? readFileSync(join(root, 'dist/index.html'), 'utf8') : '';
const live = process.env.SMOKE_URL;

test('built page has semantic landmarks', () => {
  assert.ok(html, 'run npm run build first');
  for (const re of [/<html lang="[^"]+"/, /<main id="main">/, /<h1>[^<]+<\/h1>/, /<header[ >]/, /<footer[ >]/])
    assert.match(html, re);
});

test('identity comes from site.config.json', () => {
  assert.ok(html.includes(`<title>${cfg.name}</title>`));
});

test('no analytics or tracking scripts or forms', () => {
  assert.doesNotMatch(html, /<script|<form|<iframe|google-analytics|gtag|plausible/i);
});

test('asset links use the configured base path', () => {
  assert.ok(html.includes(`href="${cfg.basePath}styles.css"`));
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
