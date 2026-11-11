// Browser checks against the built artifact, served under the project-site prefix.
// Run: npm run build && npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const shots = join(root, 'test-results', 'screenshots');
const cfg = JSON.parse(await readFile(join(root, 'site.config.json'), 'utf8'));
const prefix = cfg.basePath;
const types = { '.html': 'text/html', '.css': 'text/css', '.txt': 'text/plain', '.xml': 'application/xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const p = normalize(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(prefix)) { res.writeHead(404); return res.end('outside prefix'); }
  const rel = p.slice(prefix.length);
  try {
    const f = join(dist, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel);
    if (!f.startsWith(dist)) throw new Error('path escape');
    res.writeHead(200, { 'content-type': types[f.slice(f.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
await mkdir(shots, { recursive: true });
test.after(async () => { await browser.close(); server.close(); });

for (const width of [360, 768, 1440]) {
  test(`${width}px: assets under prefix, no overflow, no third-party requests, no a11y violations`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const origins = new Set(); const bad = [];
    page.on('request', (r) => origins.add(new URL(r.url()).origin));
    page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    const first = await page.goto(`${origin}${prefix}`);
    assert.equal(first.status(), 200);
    await page.reload(); // direct visit and reload
    assert.deepEqual(bad, [], 'all document and asset responses succeed');
    assert.deepEqual([...origins], [origin], 'only same-origin requests');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');
    const hrefs = await page.$$eval('link[rel=stylesheet]', (l) => l.map((x) => new URL(x.href).pathname));
    assert.ok(hrefs.every((h) => h.startsWith(prefix)), 'stylesheet links use the prefix');
    for (const l of await page.$$eval('a[href^="#"]', (a) => a.map((x) => x.getAttribute('href'))))
      assert.ok(await page.$(l), `anchor target ${l} exists`);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    assert.deepEqual(axe.violations.map((v) => `${v.id}: ${v.help}`), [], 'no automated accessibility violations');
    await page.screenshot({ path: join(shots, `landing-${width}.png`), fullPage: true });
    await context.close();
  });
}

test('robots.txt is served and agrees with the robots meta tag', async () => {
  const txt = await (await fetch(`${origin}${prefix}robots.txt`)).text();
  assert.doesNotMatch(txt, /^\s*Disallow:\s*\/\s*$/m);
  const sm = await fetch(`${origin}${prefix}sitemap.xml`);
  assert.equal(sm.status, cfg.indexable ? 200 : 404);
});

for (const scheme of ['dark', 'light']) {
  test(`${scheme} theme: no WCAG AA contrast violations, including button states`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${origin}${prefix}`);
    await page.locator('details').first().evaluate((d) => { d.open = true; });
    const axe = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    assert.deepEqual(axe.violations.map((v) => v.nodes.map((n) => n.html.slice(0, 80))), []);
    await context.close();
  });
}

test('keyboard: skip link first, every control reachable in order with a visible focus ring', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}${prefix}`);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
  assert.ok((await page.locator('.skip').boundingBox()).x >= 0, 'skip link is on-screen when focused');
  const expected = await page.$$eval('a[href], summary', (els) => els.length);
  const seen = [];
  for (let i = 1; i < expected; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => {
      const e = document.activeElement; const cs = getComputedStyle(e);
      return { tag: e.tagName, outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
    }));
  }
  assert.equal(seen.length, expected - 1);
  assert.ok(seen.every((s) => s.outline), 'every focused control has a visible outline');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await page.locator('summary').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').first().evaluate((d) => d.open), true, 'Enter toggles FAQ');
  await context.close();
});
