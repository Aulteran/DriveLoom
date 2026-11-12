// Browser smoke test of the web client against the real composed application:
// the main journeys, no console errors, no CSP violations, no horizontal
// scroll on a phone. Run with `npm run test:browser`; needs DATABASE_URL and a
// Playwright Chromium (CI installs it; PLAYWRIGHT_BROWSERS_PATH works locally).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { createApplication } from '../../src/application.ts';
import { defaultConfig } from '../../src/auth/config.ts';
import { trustFromList } from '../../src/http/ip.ts';
import { createTestDb } from '../helpers/index.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const WEB = fileURLToPath(new URL('../../../web/', import.meta.url));
const ADMIN = { email: 'admin@example.test', password: 'correct horse battery' };
const FRIEND = { email: 'friend@example.test', password: 'another long passphrase' };

test('web client journeys', { skip, timeout: 180_000 }, async (t: TestContext) => {
  const db = (await createTestDb())!;
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = defaultConfig({ publicOrigin: base, secretKey: Buffer.alloc(32, 9), registration: 'closed', secureCookies: false, ipTrust: trustFromList([]) });
  const handler = createApplication({ db: db.pool, config, mailer: null, oidc: null, now: () => new Date() }, { webDir: WEB });
  server.on('request', (q, s) => void handler(q, s));

  const browser = await chromium.launch();
  const problems: string[] = [];
  const watch = (p: Page) => {
    p.on('console', (m) => {
      // The signed-out session probe is an expected 401.
      if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    return p;
  };
  const page = watch(await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage());
  page.setDefaultTimeout(8000);
  const noErrorPage = async () => assert.equal(await page.getByText('Something went wrong').count(), 0);

  let vehicle = '';
  const axe = async (label: string) => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    return r.violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  };
  try {
    await t.test('first account registers and lands on the garage', async () => {
      await page.goto(`${base}/`);
      await page.getByLabel('Email').waitFor();
      assert.deepEqual(await axe('register'), []);
      await page.getByLabel('Email').fill(ADMIN.email);
      await page.getByLabel('Password').first().fill(ADMIN.password);
      await page.getByRole('button', { name: /create|register/i }).click();
      await page.getByRole('heading', { name: 'Your vehicles' }).waitFor();
    });

    await t.test('a vehicle is added and fill-ups produce economy', async () => {
      await page.getByLabel('Name').fill('Golf');
      await page.getByLabel('Make').fill('VW');
      await page.getByRole('button', { name: 'Add vehicle' }).last().click();
      await page.getByRole('heading', { name: 'Golf' }).waitFor();
      vehicle = new URL(page.url()).hash.replace(/^#\//, '').split('/').slice(0, 2).join('/');
      assert.match(vehicle, /^vehicles\/[0-9a-f-]{36}$/);
      // Recent dates, so the default statistics period always includes them.
      const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10) + 'T10:00';
      const fills = [[daysAgo(40), '10000', '40', '70'], [daysAgo(25), '10600', '42', '73.5'], [daysAgo(10), '11150', '38.5', '68']] as const;
      for (const [i, [when, odo, vol, amount]] of fills.entries()) {
        await page.getByRole('button', { name: /add fill-up/i }).first().click();
        await page.getByLabel('Date and time').fill(when);
        await page.getByLabel('Odometer reading').fill(odo);
        await page.getByLabel('Fuel volume').fill(vol);
        await page.getByLabel('Amount paid').fill(amount);
        await page.getByRole('button', { name: 'Add fill-up' }).last().click();
        // The log re-renders after the toast appears; wait for the new row and the closed form before the next entry.
        await page.locator('main tbody tr').nth(i).waitFor();
        await page.getByLabel('Odometer reading').waitFor({ state: 'detached' });
        await page.waitForLoadState('networkidle');
      }
      await page.getByText('7.00 L/100 km').first().waitFor();
    });

    await t.test('every vehicle tab renders', async () => {
      await page.getByRole('link', { name: 'Statistics' }).click();
      await page.locator('svg.chart').waitFor();
      for (const tab of ['Members', 'Import & export', 'Settings']) {
        await page.getByRole('link', { name: tab, exact: true }).last().click();
        await page.waitForLoadState('networkidle');
        await noErrorPage();
      }
      await page.getByLabel(/compare|friends/i).first().check();
      await page.waitForLoadState('networkidle');
    });

    await t.test('settings and administration render', async () => {
      for (const hash of ['settings/preferences', 'settings/profile', 'settings/security', 'admin/users', 'admin/invites', 'admin/audit', 'friends']) {
        await page.goto(`${base}/#/${hash}`);
        await page.waitForLoadState('networkidle');
        await page.locator('main h1').first().waitFor();
        await noErrorPage();
      }
    });

    await t.test('screens pass automated WCAG 2.2 AA checks', async () => {
      const findings: string[] = [];
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        for (const hash of ['', vehicle, `${vehicle}/stats`, `${vehicle}/members`, `${vehicle}/data`, `${vehicle}/settings`, 'friends', 'settings/preferences', 'settings/security', 'admin/users', 'admin/invites', 'admin/audit']) {
          await page.goto(`${base}/#/${hash}`);
          await page.waitForLoadState('networkidle');
          await page.locator('main h1').first().waitFor();
          findings.push(...await axe(`${colorScheme} #/${hash}`));
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
      assert.deepEqual(findings, []);
    });

    await t.test('preferences change the units shown', async () => {
      await page.goto(`${base}/#/settings/preferences`);
      await page.getByLabel('Fuel economy').selectOption('mpg_us');
      await page.getByRole('button', { name: 'Save preferences' }).click();
      await page.getByText('Preferences saved.').waitFor();
      await page.goto(`${base}/#/friends`);
      await page.getByText('Economy (mpg (US))').waitFor();
    });

    let link = '';
    await t.test('an administrator creates an invitation link', async () => {
      await page.goto(`${base}/#/admin/invites`);
      await page.getByRole('button', { name: 'Create invitation' }).click();
      link = (await page.locator('.notice code.secret').textContent()) ?? '';
      assert.match(link, /#\/register\?invite=/);
    });

    await t.test('the phone layout has no horizontal scroll', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const hash of ['', 'friends', 'settings/security', 'admin/users']) {
        await page.goto(`${base}/#/${hash}`);
        await page.waitForLoadState('networkidle');
        assert.equal(await page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1'), false, `#/${hash} overflows`);
      }
      await page.setViewportSize({ width: 1100, height: 900 });
    });

    await t.test('an invited person registers and sends a friend request', async () => {
      const p2 = watch(await (await browser.newContext()).newPage());
      p2.setDefaultTimeout(8000);
      await p2.goto(link);
      await p2.getByLabel('Email').fill(FRIEND.email);
      await p2.getByLabel('Password').first().fill(FRIEND.password);
      await p2.getByRole('button', { name: /create|register/i }).click();
      await p2.getByRole('heading', { name: 'Your vehicles' }).waitFor();
      await p2.goto(`${base}/#/friends`);
      await p2.getByLabel('Their email').fill(ADMIN.email);
      await p2.getByRole('button', { name: 'Send request' }).click();
      await p2.getByText('Request sent.').waitFor();
    });

    await t.test('signing out and back in, the request is accepted', async () => {
      await page.getByRole('button', { name: /sign out/i }).click();
      await page.getByLabel('Email').fill(ADMIN.email);
      await page.getByLabel('Password').fill(ADMIN.password);
      await page.getByRole('button', { name: /^sign in$/i }).click();
      await page.getByRole('heading', { name: 'Your vehicles' }).waitFor();
      await page.goto(`${base}/#/friends`);
      await page.getByRole('button', { name: 'Accept' }).click();
      await page.getByText(FRIEND.email).waitFor();
      await page.getByRole('heading', { name: 'Your friends' }).waitFor();
    });

    assert.deepEqual(problems, [], 'no console errors, page errors or CSP violations');
  } finally {
    await browser.close();
    server.close(); server.closeAllConnections();
    await db.drop();
  }
});
