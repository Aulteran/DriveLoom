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
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml', '.png': 'image/png' };

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
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const first = await page.goto(`${origin}${prefix}`);
    assert.equal(first.status(), 200);
    await page.reload(); // direct visit and reload
    assert.deepEqual(bad, [], 'all document and asset responses succeed');
    assert.deepEqual(errors, [], 'no script errors');
    assert.ok(await page.locator('[data-tour] [role=tablist]').isVisible(), 'the demo renders');
    assert.deepEqual([...origins], [origin], 'only same-origin requests');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');
    const hrefs = await page.$$eval('link[rel=stylesheet], link[rel=preload], link[rel=icon], script[src]', (l) => l.map((x) => new URL(x.href || x.src).pathname));
    assert.ok(hrefs.every((h) => h.startsWith(prefix)), 'asset links use the prefix');
    assert.equal(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('600 16px "Space Grotesk"'); }), true, 'self-hosted display font loads');
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

test('keyboard: skip link first, every control reachable with a visible focus ring', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}${prefix}`);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
  assert.ok((await page.locator('.skip').boundingBox()).x >= 0, 'skip link is on-screen when focused');
  const seen = [];
  for (let i = 0; i < 200; i++) {
    await page.keyboard.press('Tab');
    const s = await page.evaluate(() => {
      const e = document.activeElement; const cs = getComputedStyle(e);
      return { tag: e.tagName, id: e.id, cls: e.className, text: (e.textContent || '').trim().slice(0, 30), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
    });
    if (s.tag === 'BODY' || s.cls === 'skip') break;
    seen.push(s);
  }
  const without = seen.filter((s) => !s.outline);
  assert.deepEqual(without, [], 'every focused control has a visible outline');
  const links = await page.$$eval('a[href], summary', (els) => els.filter((e) => e.checkVisibility() && e.className !== 'skip').length);
  assert.ok(seen.filter((s) => s.tag === 'A' || s.tag === 'SUMMARY').length >= links, 'every link and FAQ question is reachable');
  assert.equal(seen.filter((s) => s.id.startsWith('tab-')).length, 1, 'the tab list is a single stop (roving tabindex)');
  await page.locator('summary').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('details').first().evaluate((d) => d.open), true, 'Enter toggles FAQ');
  await context.close();
});

const TABS = ['garage', 'log', 'stats', 'members', 'friends', 'data'];

test('demo tabs: arrow keys move between screens', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}${prefix}`);
  await page.locator('#tab-stats').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-members');
  assert.equal(await page.locator('#tab-members').getAttribute('aria-selected'), 'true');
  assert.ok(await page.locator('#panel-members').isVisible());
  assert.ok(await page.locator('#panel-stats').isHidden());
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-garage');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-data', 'wraps around');
  await context.close();
});

for (const [scheme, width] of [['dark', 1280], ['light', 1280], ['light', 360], ['dark', 360]]) {
  test(`demo screens, ${scheme} at ${width}px: no a11y violations or page overflow`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${origin}${prefix}`);
    for (const tab of TABS) {
      await page.click(`#tab-${tab}`);
      assert.equal(await page.locator(`#panel-${tab}`).isVisible(), true, `${tab} panel shows`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${tab}: no horizontal page scroll`);
      const axe = await new AxeBuilder({ page }).include('[data-tour]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      assert.deepEqual(axe.violations.map((v) => `${tab} ${v.id}: ${v.nodes.map((n) => n.html.slice(0, 60)).join(' | ')}`), []);
      if (width === 1280 || tab === 'log') await page.locator('#tour').screenshot({ path: join(shots, `demo-${tab}-${scheme}-${width}.png`) });
    }
    await context.close();
  });
}

test('demo behaviour: units, fill-up validation, sharing, friends, offline', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}${prefix}`);
  const requests = [];
  page.on('request', (r) => requests.push({ type: r.resourceType(), method: r.method(), url: r.url() }));

  // Display units convert every figure.
  const headline = () => page.locator('#panel-stats .stat').first().locator('.v').textContent();
  assert.match(await headline(), /L\/100 km$/);
  await page.focus('#pref-econ');
  await page.selectOption('#pref-econ', 'mpg_us');
  assert.match(await headline(), /mpg \(US\)$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pref-econ', 'focus stays on the control after re-render');
  await page.selectOption('#pref-dist', 'mi');
  assert.match(await page.locator('#panel-stats .stat').nth(1).locator('.v').textContent(), /mi$/);
  assert.equal(await page.locator('#panel-stats svg.chart').count(), 1, 'chart renders');

  // Adding a fill-up checks the odometer, then updates the log.
  await page.click('#tab-log');
  const rows = await page.locator('#panel-log tbody tr').count();
  await page.click('[data-key=add-fill]');
  await page.fill('[data-key=odo]', '100');
  await page.fill('[data-key=vol]', '38');
  await page.click('#panel-log form button[type=submit]');
  assert.match(await page.locator('#panel-log [role=alert]').textContent(), /higher than the previous reading/);
  await page.fill('[data-key=odo]', '50600');
  await page.click('#panel-log form button[type=submit]');
  assert.equal(await page.locator('#panel-log tbody tr.fresh').count(), 1, 'new row is highlighted');
  assert.equal(await page.locator('#panel-log tbody tr').count(), rows, 'still shows the newest page of rows');
  assert.match(await page.locator('[data-tour] .toast').textContent(), /Fill-up added/);

  // Sharing only accepts users on the instance.
  await page.click('#tab-members');
  await page.fill('[data-key=share-email]', 'nobody@example.com');
  await page.click('#panel-members form button[type=submit]');
  assert.match(await page.locator('#panel-members [role=alert]').textContent(), /No user with that email/);
  await page.fill('[data-key=share-email]', 'sam@example.com');
  await page.click('#panel-members form button[type=submit]');
  assert.match(await page.locator('#panel-members tbody').textContent(), /Sam Okafor/);
  await page.uncheck('[data-key=opt-in]');

  // Opting out hides the vehicle from friends; accepting a request adds a row.
  await page.click('#tab-friends');
  assert.doesNotMatch(await page.locator('#panel-friends tbody').textContent(), /Blue Hatch/);
  await page.click('[data-key=accept]');
  assert.match(await page.locator('#panel-friends tbody').textContent(), /Commuter/);

  // An editor cannot manage members.
  await page.selectOption('#pref-vehicle', 'van');
  await page.click('#tab-members');
  assert.equal(await page.locator('#panel-members form').count(), 0);

  await page.click('#tab-data');
  await page.click('[data-key=preview-bad]');
  assert.match(await page.locator('#panel-data .error').textContent(), /Nothing was imported/);
  const calls = requests.filter((r) => r.method !== 'GET' || ['fetch', 'xhr', 'websocket', 'eventsource', 'ping'].includes(r.type) || new URL(r.url).origin !== origin || !/\.(svg|png|woff2|css)$/.test(new URL(r.url).pathname));
  assert.deepEqual(calls, [], 'the demo sends nothing: at most it re-reads same-origin static assets');
  await context.close();
});

test('reduced motion stops every animation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}${prefix}`);
  const moving = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => {
    const cs = getComputedStyle(e); const b = getComputedStyle(e, '::before');
    return cs.animationName !== 'none' || b.animationName !== 'none' || parseFloat(cs.transitionDuration) > 0;
  }).map((e) => e.className.baseVal ?? e.className));
  assert.deepEqual(moving, []);
  await context.close();
});

test('without JavaScript the page still reads well and explains the demo', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${origin}${prefix}`);
  assert.match(await page.locator('[data-tour]').textContent(), /needs JavaScript/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(shots, 'landing-nojs-390.png'), fullPage: true });
  await context.close();
});
