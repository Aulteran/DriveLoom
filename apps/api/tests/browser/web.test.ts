// Browser smoke test of the web client against the real composed application:
// the main journeys, no console errors, no CSP violations, the phone shell with
// no horizontal scroll. Run with `npm run test:browser`; needs DATABASE_URL and a
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
import { Integrations } from '../../src/admin/integrations.ts';
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
  const integrations = new Integrations(db.pool, config.secretKey, base, { smtp: null, oidc: null });
  await integrations.load();
  const handler = createApplication({ db: db.pool, config, integrations, get mailer() { return integrations.mailer; }, get oidc() { return integrations.oidc; }, now: () => new Date() }, { webDir: WEB });
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
    await t.test('first account registers and lands on the welcome screen', async () => {
      await page.goto(`${base}/`);
      await page.getByLabel('Email').waitFor();
      assert.deepEqual(await axe('register'), []);
      // The administrator picks the instance default units at setup.
      await page.getByText('Default units for this instance').waitFor();
      assert.equal(await page.getByLabel('Distance').inputValue(), 'km');
      await page.getByLabel('Email').fill(ADMIN.email);
      await page.getByLabel('Password').first().fill(ADMIN.password);
      await page.getByRole('button', { name: /create|register/i }).click();
      await page.getByRole('heading', { name: 'Welcome to DriveLoom' }).waitFor();
      assert.deepEqual(await axe('welcome'), []);
    });

    await t.test('a vehicle is added and fill-ups produce economy', async () => {
      await page.getByLabel('Nickname (optional)').fill('Golf');
      await page.getByLabel('Make').fill('VW');
      await page.getByRole('button', { name: 'Add vehicle' }).click();
      await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      await page.getByRole('heading', { name: 'No fill-ups yet' }).waitFor();
      vehicle = new URL(page.url()).hash.replace(/^#\//, '').split('/').slice(0, 2).join('/');
      assert.match(vehicle, /^vehicles\/[0-9a-f-]{36}$/);
      // The empty dashboard offers the first fill-up; it opens the form on the fuel log.
      await page.getByRole('link', { name: 'Add fill-up' }).click();
      await page.getByLabel('Odometer reading').waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
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

    await t.test('the dashboard shows charts and reports', async () => {
      const vehicleNav = page.getByRole('navigation', { name: 'Vehicle' });
      await vehicleNav.getByRole('link', { name: 'Dashboard' }).click();
      await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      await page.locator('svg.chart').first().waitFor();
      assert.equal(await page.locator('svg.chart').count(), 4, 'economy, spending, distance and fuel charts');
      for (const name of ['Monthly spending', 'At a glance', 'Recent fill-ups']) await page.getByRole('heading', { name }).waitFor();
      await page.getByText('Average economy').waitFor();
      await page.getByLabel('Period', { exact: true }).selectOption('all');
      await page.waitForURL(/window=all/);
      await page.locator('svg.chart').first().waitFor();
      await noErrorPage();
      // The old statistics URL still works and now opens the dashboard.
      await page.goto(`${base}/#/${vehicle}/stats`);
      await page.getByRole('heading', { name: 'At a glance' }).waitFor();
    });

    await t.test('every vehicle section renders from the sidebar', async () => {
      const vehicleNav = page.getByRole('navigation', { name: 'Vehicle' });
      for (const [link, heading] of [['Members', 'Members'], ['Import & export', 'Import & export'], ['Vehicle settings', 'Vehicle settings']] as const) {
        await vehicleNav.getByRole('link', { name: link, exact: true }).click();
        await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
        await noErrorPage();
      }
      await page.getByLabel("Share this vehicle's economy with my friends").check();
      await page.waitForLoadState('networkidle');
    });

    await t.test('the garage adds a second vehicle and the switcher changes vehicle', async () => {
      await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Garage' }).click();
      await page.getByRole('heading', { name: 'Garage', level: 1 }).waitFor();
      await page.getByRole('button', { name: 'Add vehicle' }).first().click();
      await page.getByLabel('Nickname (optional)').fill('Clio');
      await page.locator('form').getByRole('button', { name: 'Add vehicle' }).click();
      await page.getByRole('heading', { name: 'Clio', level: 1 }).waitFor();
      await page.getByRole('combobox', { name: 'Vehicle' }).selectOption({ label: 'Golf · VW' });
      await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      // The root opens the vehicle last looked at.
      await page.goto(`${base}/#/`);
      await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Vehicle' }).inputValue(), vehicle.split('/')[1]);
    });

    await t.test('the theme toggle overrides the system and survives a reload', async () => {
      const findings: string[] = [];
      for (const [system, forced] of [['light', 'Dark'], ['dark', 'Light']] as const) {
        await page.emulateMedia({ colorScheme: system });
        await page.goto(`${base}/#/${vehicle}`);
        await page.getByRole('heading', { name: 'At a glance' }).waitFor();
        await page.getByRole('group', { name: 'Colour theme' }).getByRole('button', { name: forced }).click();
        assert.equal(await page.evaluate('document.documentElement.dataset.theme'), forced.toLowerCase());
        await page.reload();
        await page.getByRole('heading', { name: 'At a glance' }).waitFor();
        assert.equal(await page.evaluate('document.documentElement.dataset.theme'), forced.toLowerCase(), 'kept after reload');
        assert.equal(await page.getByRole('button', { name: forced }).getAttribute('aria-pressed'), 'true');
        for (const hash of [vehicle, `${vehicle}/log`, 'garage', 'friends', 'settings/security']) {
          await page.goto(`${base}/#/${hash}`);
          await page.waitForLoadState('networkidle');
          await page.locator('main h1').first().waitFor();
          findings.push(...await axe(`forced ${forced} on ${system} #/${hash}`));
        }
        await page.getByRole('button', { name: 'System' }).click();
        assert.equal(await page.evaluate('document.documentElement.dataset.theme ?? null'), null);
      }
      await page.emulateMedia({ colorScheme: 'light' });
      assert.deepEqual(findings, []);
    });

    await t.test('settings and administration render', async () => {
      for (const hash of ['garage', 'settings/preferences', 'settings/profile', 'settings/security', 'admin/users', 'admin/invites', 'admin/units', 'admin/email', 'admin/signin', 'admin/audit', 'friends']) {
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
        for (const hash of [vehicle, `${vehicle}?window=all`, `${vehicle}/log`, `${vehicle}/members`, `${vehicle}/data`, `${vehicle}/settings`, 'garage', 'friends', 'settings/preferences', 'settings/security', 'admin/users', 'admin/invites', 'admin/units', 'admin/email', 'admin/signin', 'admin/audit']) {
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
      assert.equal(await page.getByLabel('Fuel economy').inputValue(), '', 'follows the instance default until changed');
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

    await t.test('an administrator saves email and sign-on settings, and the secrets stay hidden', async () => {
      await page.goto(`${base}/#/admin/email`);
      await page.getByRole('heading', { name: 'Email (SMTP)' }).waitFor();
      await page.getByLabel('Server').fill('smtp.example.test');
      await page.getByLabel('Username').fill('mailer');
      await page.getByLabel('Password', { exact: true }).fill('smtp-secret-value');
      await page.getByLabel('From address').fill('DriveLoom <noreply@example.test>');
      await page.getByRole('button', { name: 'Save email settings' }).click();
      await page.getByText('Email is on').waitFor();
      assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('placeholder'), 'Saved. Leave blank to keep it.');
      assert.equal((await page.content()).includes('smtp-secret-value'), false);
      assert.deepEqual(await axe('admin email'), []);
      // Switching it off keeps the fields saved.
      await page.getByLabel('Turn on email').uncheck();
      await page.getByRole('button', { name: 'Save email settings' }).click();
      await page.getByText('Email is turned off (settings saved)').waitFor();
      assert.equal(await page.getByLabel('Server').inputValue(), 'smtp.example.test');
      assert.equal(await page.getByLabel('Turn on email').isChecked(), false);
      await page.getByLabel('Turn on email').check();
      await page.getByRole('button', { name: 'Save email settings' }).click();
      await page.getByText('Email is on').waitFor();

      await page.goto(`${base}/#/admin/signin`);
      await page.getByRole('heading', { name: 'Single sign-on (OIDC)' }).waitFor();
      assert.equal(await page.locator('code.secret').textContent(), `${base}/v1/auth/oidc/callback`);
      await page.getByLabel('Issuer URL').fill('https://idp.example.test/');
      await page.getByLabel('Client ID').fill('driveloom');
      await page.getByLabel('Client secret').fill('client-secret-value');
      await page.getByRole('button', { name: 'Save sign-on settings' }).click();
      await page.getByText('Single sign-on is on').waitFor();
      assert.equal((await page.content()).includes('client-secret-value'), false);
      assert.deepEqual(await axe('admin sign-on'), []);

      await page.getByRole('button', { name: 'Remove sign-on' }).click();
      await page.locator('dialog').getByRole('button', { name: 'Remove sign-on' }).click();
      await page.getByText('Single sign-on is off').waitFor();
      await noErrorPage();
    });

    const overflows = (p: Page) => p.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1');

    await t.test('an 800px window keeps the desktop shell, with a drawer and no horizontal scroll', async () => {
      await page.setViewportSize({ width: 800, height: 900 });
      for (const hash of [vehicle, `${vehicle}/log`, 'garage', 'friends', 'settings/security', 'admin/users']) {
        await page.goto(`${base}/#/${hash}`);
        await page.waitForLoadState('networkidle');
        await page.locator('main h1').first().waitFor();
        assert.equal(await overflows(page), false, `#/${hash} overflows`);
      }
      assert.equal(await page.getByRole('navigation', { name: 'Main' }).count(), 0, 'no phone tab bar');
      const nav = page.getByRole('navigation', { name: 'Account' });
      await nav.waitFor({ state: 'hidden' }); // the drawer starts closed
      await page.getByRole('button', { name: 'Open menu' }).click();
      await nav.getByRole('link', { name: 'Friends' }).waitFor();
      assert.equal(await overflows(page), false, 'the open drawer overflows');
      assert.deepEqual(await axe('open drawer'), []);
      await page.keyboard.press('Escape');
      await nav.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await nav.getByRole('link', { name: 'Friends' }).click();
      await page.getByRole('heading', { name: 'Friends', level: 1 }).waitFor();
      await nav.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 1100, height: 900 });
    });

    await t.test('a phone gets the tab-bar shell: routes fit, the vehicle sheet switches, More leads on', async () => {
      // A separate context with the same session, so the vehicle it picks is not remembered for the desktop page.
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
      const p = watch(await ctx.newPage());
      p.setDefaultTimeout(8000);
      const phoneAxe = async (label: string) => (await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze())
        .violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      const tabs = p.getByRole('navigation', { name: 'Main' });
      const tab = (name: string) => tabs.getByRole('link', { name, exact: false });
      // A fresh document per route, so nothing from the previous screen is still on show.
      const open = async (hash: string) => {
        await p.goto('about:blank');
        await p.goto(`${base}/#/${hash}`);
        await p.waitForLoadState('networkidle');
        await p.locator('main h1').first().waitFor();
      };
      try {
        await p.goto(`${base}/#/${vehicle}`);
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        for (const name of ['Home', 'History', 'Fill up', 'Vehicles', 'More']) await tab(name).waitFor();
        assert.equal(await tab('Home').getAttribute('aria-current'), 'page');
        assert.equal(await p.locator('#sidebar').isVisible(), false, 'no desktop sidebar');
        assert.equal(await p.locator('#mobilebar').isVisible(), false, 'no desktop top bar');
        assert.equal(await p.getByRole('button', { name: 'Open menu' }).count(), 0);

        const routes = [[vehicle, 'Home'], [`${vehicle}/log`, 'History'], [`${vehicle}/members`, 'Vehicles'], [`${vehicle}/data`, 'Vehicles'], [`${vehicle}/settings`, 'Vehicles'],
          ['garage', 'Vehicles'], ['more', 'More'], ['more/install', 'More'], ['friends', 'More'], ['settings/preferences', 'More'], ['settings/security', 'More'], ['admin/users', 'More'], ['admin/audit', 'More']] as const;
        for (const [hash, current] of routes) {
          await open(hash);
          assert.equal(await overflows(p), false, `#/${hash} overflows on a phone`);
          assert.equal(await tab(current).getAttribute('aria-current'), 'page', `#/${hash} selects ${current}`);
        }

        // The shell and More pass axe in both themes.
        const findings: string[] = [];
        for (const colorScheme of ['light', 'dark'] as const) {
          await p.emulateMedia({ colorScheme });
          for (const hash of [vehicle, `${vehicle}/log`, 'more']) {
            await open(hash);
            findings.push(...await phoneAxe(`phone ${colorScheme} #/${hash}`));
          }
        }
        await p.emulateMedia({ colorScheme: 'light' });
        assert.deepEqual(findings, []);

        // The vehicle chip opens a modal sheet that switches the active vehicle.
        await open(vehicle);
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        await p.getByRole('button', { name: 'Vehicle: Golf', exact: true }).click();
        const sheet = p.getByRole('dialog', { name: 'Switch vehicle' });
        await sheet.waitFor();
        assert.equal(await sheet.getByRole('button', { name: /^Golf/ }).getAttribute('aria-pressed'), 'true');
        assert.equal(await overflows(p), false, 'the open sheet overflows');
        assert.deepEqual(await phoneAxe('vehicle sheet'), []);
        await p.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached' });
        await p.getByRole('button', { name: /^Vehicle: / }).click();
        await sheet.getByRole('button', { name: /^Clio/ }).click();
        await p.getByRole('heading', { name: 'Clio', level: 1 }).waitFor();
        await p.getByRole('button', { name: 'Vehicle: Clio', exact: true }).waitFor();
        await tab('History').click();
        await p.getByRole('heading', { name: 'Fuel log', level: 1 }).waitFor();
        assert.match(p.url(), /#\/vehicles\/[0-9a-f-]{36}\/log$/);
        assert.notEqual(p.url().split('#/')[1], `${vehicle}/log`, 'History follows the active vehicle');

        // Fill up opens its sheet over the current screen and closes back to it.
        await tab('Fill up').click();
        const fill = p.getByRole('dialog', { name: 'Add a fill-up' });
        await fill.waitFor();
        await p.keyboard.press('Escape');
        await fill.waitFor({ state: 'detached' });
        await p.waitForURL(/\/log$/);
        await p.getByRole('heading', { name: 'Fuel log', level: 1 }).waitFor();

        // More leads to Friends, with a way back.
        await tab('More').click();
        await p.getByRole('heading', { name: 'More', level: 1 }).waitFor();
        await p.getByRole('navigation', { name: 'More' }).getByRole('link', { name: /^Friends/ }).click();
        await p.getByRole('heading', { name: 'Friends', level: 1 }).waitFor();
        assert.equal(await tab('More').getAttribute('aria-current'), 'page');
        await p.getByRole('link', { name: 'More', exact: true }).first().click();
        await p.getByRole('heading', { name: 'More', level: 1 }).waitFor();
      } finally { await ctx.close(); }

      // Signed out, the sign-in screen is full screen: no tab bar.
      const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const q = watch(await anon.newPage());
      try {
        await q.goto(`${base}/`);
        await q.getByRole('heading', { name: 'Sign in' }).waitFor();
        assert.equal(await q.getByRole('navigation', { name: 'Main' }).isVisible(), false);
        assert.equal(await overflows(q), false, 'sign-in overflows on a phone');
      } finally { await anon.close(); }
    });

    await t.test('resizing across 700px reloads into the other shell', async () => {
      // Marks the document, resizes, then waits until a new document has replaced it.
      // (Polled from here: waitForFunction would need 'unsafe-eval', which the CSP forbids.)
      const crossTo = async (width: number, height: number) => {
        await page.evaluate('window.__beforeResize = true');
        await page.setViewportSize({ width, height });
        const until = Date.now() + 8000;
        while (await page.evaluate('window.__beforeResize === true').catch(() => true)) {
          assert.ok(Date.now() < until, `no reload after resizing to ${width}px`);
          await new Promise((r) => setTimeout(r, 50));
        }
        await page.waitForLoadState('networkidle');
      };
      await page.goto(`${base}/#/${vehicle}`);
      await page.getByRole('navigation', { name: 'Account' }).waitFor();
      await crossTo(390, 844);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Home' }).waitFor();
      await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      assert.equal(await page.locator('#sidebar').isVisible(), false);
      await crossTo(1100, 900);
      await page.getByRole('navigation', { name: 'Account' }).waitFor();
      await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Main' }).count(), 0);
    });

    await t.test('an invited person registers and sends a friend request', async () => {
      const p2 = watch(await (await browser.newContext()).newPage());
      p2.setDefaultTimeout(8000);
      await p2.goto(link);
      await p2.getByLabel('Email').fill(FRIEND.email);
      await p2.getByLabel('Password').first().fill(FRIEND.password);
      await p2.getByRole('button', { name: /create|register/i }).click();
      await p2.getByRole('heading', { name: 'Welcome to DriveLoom' }).waitFor();
      await p2.goto(`${base}/#/friends`);
      await p2.getByLabel('Their email').fill(ADMIN.email);
      await p2.getByRole('button', { name: 'Send request' }).click();
      await p2.getByText('Request sent.').waitFor();
    });

    await t.test('on a phone, a waiting friend request shows on More and on the Friends row', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
      const p = watch(await ctx.newPage());
      p.setDefaultTimeout(8000);
      try {
        await p.goto(`${base}/#/more`);
        await p.getByRole('heading', { name: 'More', level: 1 }).waitFor();
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More (1 friend request)' }).waitFor();
        await p.getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Friends (1 friend request)' }).waitFor();
      } finally { await ctx.close(); }
    });

    await t.test('signing out and back in, the request is accepted', async () => {
      await page.getByRole('button', { name: /sign out/i }).click();
      await page.getByRole('heading', { name: 'Sign in' }).waitFor();
      await page.getByLabel('Email', { exact: true }).fill(ADMIN.email);
      await page.getByLabel('Password').fill(ADMIN.password);
      await page.getByRole('button', { name: /^sign in$/i }).click();
      await page.getByRole('heading', { name: 'At a glance' }).waitFor();
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
