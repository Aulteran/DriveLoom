// Browser smoke test of the web client against the real composed application:
// the main journeys, no console errors, no CSP violations, the phone shell with
// no horizontal scroll. Run with `npm run test:browser`; needs DATABASE_URL and a
// Playwright Chromium (CI installs it; PLAYWRIGHT_BROWSERS_PATH works locally).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cpSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { createApplication } from '../../src/application.ts';
import { defaultConfig } from '../../src/auth/config.ts';
import { trustFromList } from '../../src/http/ip.ts';
import { Integrations } from '../../src/admin/integrations.ts';
import { createTestDb } from '../helpers/index.ts';
import { Dec } from '../../src/decimal.ts';
import { economy } from '../../src/units.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const WEB = fileURLToPath(new URL('../../../web/', import.meta.url));
const ADMIN = { email: 'admin@example.test', password: 'correct horse battery' };
const FRIEND = { email: 'friend@example.test', password: 'another long passphrase' };

test('web client journeys', { skip, timeout: 420_000 }, async (t: TestContext) => {
  const db = (await createTestDb())!;
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = defaultConfig({ publicOrigin: base, secretKey: Buffer.alloc(32, 9), registration: 'closed', secureCookies: false, ipTrust: trustFromList([]) });
  const integrations = new Integrations(db.pool, config.secretKey, base, { smtp: null, oidc: null });
  await integrations.load();
  const deps = { db: db.pool, config, integrations, get mailer() { return integrations.mailer; }, get oidc() { return integrations.oidc; }, now: () => new Date() };
  // `let`: the update test swaps in a second build of the web client to make a new service worker wait.
  let handler = createApplication(deps, { webDir: WEB });
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

    await t.test('on a phone, the quick fill-up sheet logs a fill-up with a live economy preview', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
      const p = watch(await ctx.newPage());
      p.setDefaultTimeout(8000);
      const phoneAxe = async (label: string) => (await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze())
        .violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      const sheet = p.getByRole('dialog', { name: 'Add a fill-up' });
      const odo = sheet.getByLabel('Odometer', { exact: true });
      const fuel = sheet.getByLabel('Fuel', { exact: true });
      const save = sheet.getByRole('button', { name: 'Save fill-up' });
      const drafts = () => p.evaluate('Object.keys(sessionStorage).filter((k) => k.startsWith("driveloom.fillup-draft.")).length');
      // The server's own arithmetic gives the figure the preview must show (economy is mpg (US) since the preferences test).
      const expected = `${economy(Dec.parse('500'), Dec.parse('35.5'), 'mpg_us')!.toFixed(2)} mpg (US)`;
      try {
        await p.goto(`${base}/#/${vehicle}`);
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fill up' }).click();
        await sheet.waitFor();
        // Opens on the odometer with the decimal keypad, prefilled with the latest reading.
        await sheet.getByText('Last reading 11150 km').waitFor();
        assert.equal(await odo.getAttribute('inputmode'), 'decimal');
        assert.equal(await fuel.getAttribute('inputmode'), 'decimal');
        assert.equal(await p.evaluate('document.activeElement?.getAttribute("name")'), 'odometer', 'odometer has focus');
        assert.equal(await odo.inputValue(), '11150');
        assert.equal(await overflows(p), false, 'the fill-up sheet overflows');
        assert.equal(await drafts(), 0, 'nothing typed, nothing kept');

        // A locale comma becomes a point, and the preview appears before saving.
        await odo.fill('11650');
        await fuel.fill('35,5');
        assert.equal(await fuel.inputValue(), '35.5');
        await sheet.locator('.m-fu-bar').getByText(expected).waitFor();
        await sheet.getByText('500.0 km on 35.50 L').waitFor();

        // The draft survives a reload, then reopens with the sheet.
        assert.equal(await drafts(), 1);
        await p.reload();
        await sheet.waitFor();
        await sheet.getByText('Restored the entry you were typing.').waitFor();
        assert.equal(await odo.inputValue(), '11650');
        assert.equal(await fuel.inputValue(), '35.5');
        await sheet.locator('.m-fu-bar').getByText(expected).waitFor();

        // Both themes pass axe with the sheet open.
        const findings: string[] = [];
        for (const colorScheme of ['dark', 'light'] as const) {
          await p.emulateMedia({ colorScheme });
          await p.waitForTimeout(300); // let colour transitions settle before measuring contrast
          findings.push(...await phoneAxe(`fill-up sheet ${colorScheme}`));
        }
        assert.deepEqual(findings, []);

        // Validation is inline, announced and checked on the phone before any request.
        await odo.fill('9000');
        await fuel.fill('');
        await save.click();
        await sheet.getByRole('alert').getByText('Fix 2 fields to save.').waitFor();
        await sheet.getByText('The odometer reading is lower than an earlier record (11150 km). Check the digits.').waitFor();
        await sheet.getByText('Enter how much fuel you bought.').waitFor();
        assert.equal(await odo.getAttribute('aria-invalid'), 'true');
        assert.equal(await p.evaluate('document.activeElement?.getAttribute("name")'), 'odometer', 'focus moves to the first error');
        assert.match(await odo.getAttribute('aria-describedby') ?? '', /-err/);
        await fuel.fill('35.5.1');
        await fuel.blur();
        await sheet.getByText('Use digits with an optional decimal point, like 42.5.').waitFor();
        assert.deepEqual(await phoneAxe('fill-up sheet with errors'), []);
        await odo.fill('11650');
        await fuel.fill('35.5');
        await sheet.getByRole('alert').waitFor({ state: 'hidden' });

        // Offline: Save is disabled and says why; nothing is written.
        await ctx.setOffline(true);
        await sheet.getByText('You are offline.', { exact: false }).waitFor();
        assert.equal(await save.isDisabled(), true);
        assert.equal(await overflows(p), false);
        await ctx.setOffline(false);
        await sheet.getByText('You are offline.', { exact: false }).waitFor({ state: 'hidden' });
        assert.equal(await save.isDisabled(), false);

        // Saving closes the sheet, toasts the figure, clears the draft and refreshes the screen.
        await save.click();
        await sheet.waitFor({ state: 'detached' });
        await p.locator('#toast').getByText(`Fill-up saved · ${expected}`).waitFor();
        assert.equal(await drafts(), 0, 'the draft is gone after saving');
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'History' }).click();
        await p.getByRole('heading', { name: 'Fuel log', level: 1 }).waitFor();
        await p.locator('main tbody tr').first().getByText('11650 km').waitFor();
        await p.locator('main tbody tr').first().getByText(expected).waitFor();

        // Reopened, it starts from the new reading; untouched, Escape closes it at once.
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fill up' }).click();
        await sheet.getByText('Last reading 11650 km').waitFor();
        assert.equal(await sheet.getByText('Restored the entry you were typing.').isVisible(), false);
        await p.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached' });

        // Typed, closing asks first; Discard drops the draft.
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fill up' }).click();
        await sheet.getByText('Last reading 11650 km').waitFor();
        await fuel.fill('20');
        await sheet.getByRole('button', { name: 'Cancel' }).click();
        await p.getByRole('button', { name: 'Keep editing' }).click();
        assert.equal(await fuel.inputValue(), '20');
        await sheet.getByRole('button', { name: 'Cancel' }).click();
        await p.getByRole('button', { name: 'Discard' }).click();
        await sheet.waitFor({ state: 'detached' });
        assert.equal(await drafts(), 0);
        // Repeated Escape never leaves a stray discard prompt over the screen.
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fill up' }).click();
        await sheet.getByText('Last reading 11650 km').waitFor();
        await fuel.fill('20');
        for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(150); }
        assert.ok(await p.locator('dialog[open]').count() <= 1, 'at most one dialog open');
        if (await sheet.count()) {
          if (await p.getByRole('button', { name: 'Discard' }).count()) await p.getByRole('button', { name: 'Discard' }).click();
          else await sheet.getByRole('button', { name: 'Cancel' }).click().then(() => p.getByRole('button', { name: 'Discard' }).click());
          await sheet.waitFor({ state: 'detached' });
        }
        await p.evaluate('sessionStorage.clear()');

        // The dashboard's legacy "add" link opens the same sheet over the fuel log.
        await p.goto(`${base}/#/${vehicle}/log?add=1`);
        await sheet.waitFor();
        assert.match(p.url(), /\/log$/);
        await p.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached' });
        await p.getByRole('heading', { name: 'Fuel log', level: 1 }).waitFor();
      } finally { await ctx.close(); }
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

    // ---------- phone: system states, install guide and the weekly screens ----------
    const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
    /** A signed-in (or not) phone page. `lenient` ignores failed-resource console lines, for tests that cut the network on purpose. */
    const phonePage = async (opts: { signedIn?: boolean; userAgent?: string; init?: string; lenient?: boolean } = {}) => {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
        ...(opts.signedIn === false ? {} : { storageState: await page.context().storageState() }),
      });
      if (opts.init) await ctx.addInitScript(opts.init);
      const p = await ctx.newPage();
      if (opts.lenient) {
        p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|502)|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(`console: ${m.text()}`); });
        p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      } else watch(p);
      p.setDefaultTimeout(8000);
      const phoneAxe = async (label: string) => (await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze())
        .violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      // A fresh document per route, so nothing from the previous screen (or theme) is still settling.
      const open = async (hash: string) => {
        await p.goto('about:blank');
        await p.goto(`${base}/#/${hash}`);
        await p.waitForLoadState('networkidle');
        await p.locator('main h1').first().waitFor();
      };
      return { ctx, p, phoneAxe, open };
    };
    const toastSays = (p: Page, text: string | RegExp) => p.locator('#toast').getByText(text).waitFor();
    /** Every segmented-control button is a full 44px touch target. */
    const segTargets = async (p: Page) => {
      for (const b of await p.locator('.m-seg button').all()) assert.ok(((await b.boundingBox())?.height ?? 0) >= 44, 'segmented button under 44px');
    };
    /** axe in both themes on what is on screen now, waiting for colour transitions to settle. */
    const bothThemes = async (p: Page, phoneAxe: (label: string) => Promise<string[]>, label: string) => {
      const out: string[] = [];
      for (const colorScheme of ['dark', 'light'] as const) {
        await p.emulateMedia({ colorScheme });
        await p.waitForTimeout(1000);
        out.push(...await phoneAxe(`${label} ${colorScheme}`));
      }
      return out;
    };

    await t.test('on a phone, More, Settings, Account and Administration are phone screens', async () => {
      const { ctx, p, phoneAxe, open } = await phonePage();
      try {
        // More: grouped rows, install status, no theme (it moved to Settings).
        await open('more');
        const more = p.getByRole('navigation', { name: 'More' });
        for (const name of [/^Friends/, /^Settings/, /^Account and security/, /^Install the app/]) await more.getByRole('link', { name }).waitFor();
        await more.getByRole('link', { name: /^Install the app/ }).getByText('Not installed').waitFor();
        assert.equal(await p.getByRole('group', { name: 'Colour theme' }).count(), 0);

        // Settings: a unit saves as soon as it changes and can go back to the instance default.
        await more.getByRole('link', { name: /^Settings/ }).click();
        await p.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
        await p.getByRole('group', { name: 'Colour theme' }).waitFor();
        const distance = p.getByLabel('Distance');
        assert.equal(await distance.inputValue(), '', 'follows the instance default');
        assert.match(await distance.locator('option[value=""]').textContent() ?? '', /Kilometres \(default\)/);
        await distance.selectOption('mi');
        await toastSays(p, 'Distance saved.');
        await p.waitForLoadState('networkidle');
        assert.equal(await p.getByLabel('Distance').inputValue(), 'mi');
        assert.equal(await p.getByLabel('Fuel economy').inputValue(), 'mpg_us', 'the other units keep their choice');
        await p.getByLabel('Distance').selectOption('');
        await toastSays(p, 'Distance saved.');
        await p.waitForLoadState('networkidle');
        assert.equal(await p.getByLabel('Distance').inputValue(), '');

        // Profile and Account and security: rows and sheets with the right keyboards.
        await open('settings/profile');
        assert.equal(await p.getByLabel('Display name').getAttribute('autocapitalize'), 'words');
        await open('settings/security');
        await p.getByRole('heading', { name: 'Signed-in devices' }).waitFor();
        await p.getByText('This device').waitFor();
        await p.getByRole('button', { name: /^Password/ }).click();
        const pw = p.getByRole('dialog', { name: 'Change password' });
        await pw.waitFor();
        assert.equal(await pw.getByLabel('Current password').getAttribute('autocomplete'), 'current-password');
        assert.equal(await pw.getByLabel('New password').getAttribute('autocomplete'), 'new-password');
        assert.equal(await overflows(p), false, 'the password sheet overflows');
        await p.keyboard.press('Escape');
        await pw.waitFor({ state: 'detached' });

        // Administration: wrapping chips, rows that open an actions sheet.
        await open('admin/users');
        const chips = p.getByRole('navigation', { name: 'Administration sections' });
        for (const name of ['Accounts', 'Invitations', 'Default units', 'Email', 'Single sign-on', 'Audit log']) await chips.getByRole('link', { name, exact: true }).waitFor();
        assert.equal(await chips.getByRole('link', { name: 'Accounts' }).getAttribute('aria-current'), 'page');
        await p.getByRole('button', { name: new RegExp(FRIEND.email.replace('.', '\\.')) }).click();
        const user = p.getByRole('dialog', { name: FRIEND.email });
        await user.waitFor();
        await user.getByLabel('Role').waitFor();
        await user.getByRole('button', { name: 'Disable account' }).click();
        const sheetFindings = await bothThemes(p, phoneAxe, 'user actions sheet');
        const confirmDisable = p.getByRole('dialog', { name: `Disable ${FRIEND.email}?` });
        await confirmDisable.waitFor();
        sheetFindings.push(...await bothThemes(p, phoneAxe, 'confirm sheet'));
        await confirmDisable.getByRole('button', { name: 'Cancel' }).click();
        await confirmDisable.waitFor({ state: 'detached' });
        await p.keyboard.press('Escape');
        await user.waitFor({ state: 'detached' });

        // Invitations: create in a sheet, copy the one-time link, revoke with a confirmation.
        await chips.getByRole('link', { name: 'Invitations' }).click();
        await p.getByRole('heading', { name: 'Invitations', level: 2 }).waitFor();
        const before = await p.getByRole('button', { name: 'Revoke' }).count();
        await p.getByRole('button', { name: 'Invite', exact: true }).click();
        const invite = p.getByRole('dialog', { name: 'Invite someone' });
        await invite.getByRole('button', { name: 'Create invitation' }).click();
        const linkField = invite.getByLabel('Invitation link');
        await linkField.waitFor();
        assert.match(await linkField.inputValue(), /#\/register\?invite=/);
        assert.equal(await overflows(p), false, 'the invitation sheet overflows');
        sheetFindings.push(...await bothThemes(p, phoneAxe, 'invitation link sheet'));
        assert.deepEqual(sheetFindings, []);
        await invite.getByRole('button', { name: 'Done' }).click();
        await invite.waitFor({ state: 'detached' });
        await p.getByRole('button', { name: 'Revoke' }).nth(before).waitFor();
        await p.getByRole('button', { name: 'Revoke' }).first().click();
        await p.getByRole('dialog', { name: 'Revoke this invitation?' }).getByRole('button', { name: 'Revoke' }).click();
        await toastSays(p, 'Invitation removed.');
        await p.getByRole('button', { name: 'Revoke' }).nth(before).waitFor({ state: 'detached' });

        // Default units, email, sign-on and the audit log all fit and work single-column.
        await open('admin/units');
        await p.getByRole('button', { name: 'Save default units' }).click();
        await toastSays(p, 'Default units saved.');
        await open('admin/email');
        await p.getByRole('switch', { name: /Turn on email/ }).waitFor();
        await p.getByRole('button', { name: 'Save email settings' }).waitFor();
        await open('admin/signin');
        assert.match(await p.getByLabel('Redirect URI').inputValue(), /\/v1\/auth\/oidc\/callback/);
        await open('admin/audit');
        await p.locator('.m-audit code').first().waitFor();

        const findings: string[] = [];
        for (const colorScheme of ['light', 'dark'] as const) {
          await p.emulateMedia({ colorScheme });
          for (const hash of ['more', 'friends', 'settings/preferences', 'settings/profile', 'settings/security', 'admin/users', 'admin/invites', 'admin/units', 'admin/email', 'admin/signin', 'admin/audit', 'more/install']) {
            await open(hash);
            assert.equal(await overflows(p), false, `#/${hash} overflows (${colorScheme})`);
            findings.push(...await phoneAxe(`phone ${colorScheme} #/${hash}`));
          }
        }
        assert.deepEqual(findings, []);
      } finally { await ctx.close(); }
    });

    await t.test('on a phone, Friends shows requests first, stacked comparison rows and an add sheet', async () => {
      const { ctx, p, phoneAxe, open } = await phonePage();
      try {
        await open('friends');
        await segTargets(p);
        const requests = p.getByRole('region', { name: /Requests for you/ });
        await requests.getByText(FRIEND.email).waitFor();
        await requests.getByRole('button', { name: 'Accept' }).waitFor();
        await requests.getByRole('button', { name: 'Decline' }).waitFor();
        const period = p.getByRole('group', { name: 'Comparison period' });
        assert.equal(await period.getByRole('button', { name: '90 days' }).getAttribute('aria-pressed'), 'true');
        await period.getByRole('button', { name: 'All time' }).click();
        await p.waitForURL(/window=all/);
        await p.getByRole('group', { name: 'Comparison period' }).getByRole('button', { name: 'All time', pressed: true }).waitFor();
        await p.locator('.m-bar-you').first().waitFor();
        await p.getByRole('button', { name: 'Add' }).click();
        const add = p.getByRole('dialog', { name: 'Add a friend' });
        const email = add.getByLabel('Their email');
        assert.equal(await email.getAttribute('inputmode'), 'email');
        assert.equal(await email.getAttribute('autocapitalize'), 'none');
        assert.equal(await p.evaluate('document.activeElement?.name'), 'email', 'the email field has focus');
        assert.deepEqual(await bothThemes(p, phoneAxe, 'add friend sheet'), []);
        await p.keyboard.press('Escape');
        await add.waitFor({ state: 'detached' });
        assert.equal(await overflows(p), false);
      } finally { await ctx.close(); }
    });

    await t.test('on a phone, the Install screen adapts to iOS, Android, installed and insecure', async () => {
      // The server's address is shown as copyable text, not a link.
      const install = { address: async (p: Page) => {
        assert.equal(await p.getByLabel('Address').inputValue(), new URL(base).origin);
        assert.equal(await p.locator('main').getByRole('link', { name: new URL(base).host }).count(), 0);
      } };
      // iOS Safari: Share, then Add to Home Screen; a manual switch shows Android instead.
      {
        const { ctx, p, open } = await phonePage({ userAgent: IOS_UA });
        try {
          await open('more/install');
          await p.getByRole('heading', { name: 'Install DriveLoom', level: 1 }).waitFor();
          const device = p.getByRole('group', { name: 'Device' });
          assert.equal(await device.getByRole('button', { name: 'iPhone, iPad' }).getAttribute('aria-pressed'), 'true');
          await segTargets(p);
          await p.getByText('Tap Share').waitFor();
          await p.getByText('Choose Add to Home Screen').waitFor();
          await p.getByText(/It must be Safari/).waitFor();
          await install.address(p);
          await device.getByRole('button', { name: 'Android' }).click();
          await p.getByText('Choose Install app').waitFor();
          assert.equal(await overflows(p), false);
        } finally { await ctx.close(); }
      }
      // Android Chrome: the menu steps, and the browser's own prompt once it is offered.
      {
        const { ctx, p, open } = await phonePage({ userAgent: ANDROID_UA });
        try {
          await open('more/install');
          assert.equal(await p.getByRole('group', { name: 'Device' }).getByRole('button', { name: 'Android' }).getAttribute('aria-pressed'), 'true');
          await p.getByText('Choose Install app').waitFor();
          assert.equal(await p.getByRole('button', { name: 'Install app' }).count(), 0, 'no button until the browser offers a prompt');
          await p.evaluate(`(() => {
            const e = new Event('beforeinstallprompt', { cancelable: true });
            e.prompt = () => { window.__prompted = true; return Promise.resolve(); };
            e.userChoice = Promise.resolve({ outcome: 'dismissed' });
            dispatchEvent(e);
          })()`);
          await p.getByRole('button', { name: 'Install app' }).click();
          assert.equal(await p.evaluate('window.__prompted === true'), true, 'the saved prompt was shown');
        } finally { await ctx.close(); }
      }
      // Already installed (standalone display mode): no steps, an Installed note.
      {
        const standalone = `(() => {
          const mm = window.matchMedia.bind(window);
          const on = (q) => ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
          window.matchMedia = (q) => (/display-mode:\\s*standalone/.test(q) ? on(q) : mm(q));
        })();`;
        const { ctx, p, open } = await phonePage({ userAgent: IOS_UA, init: standalone });
        try {
          await open('more/install');
          assert.equal(await p.evaluate("matchMedia('(display-mode: standalone)').matches"), true, 'standalone emulated');
          await p.getByRole('heading', { name: 'Installed' }).waitFor();
          assert.equal(await p.getByRole('group', { name: 'Device' }).count(), 0);
          await install.address(p);
          await open('more');
          await p.getByRole('navigation', { name: 'More' }).getByRole('link', { name: /^Install the app/ }).getByText('Installed').waitFor();
        } finally { await ctx.close(); }
      }
      // Not a secure context: it says plainly that install needs trusted HTTPS.
      {
        const { ctx, p, open } = await phonePage({ userAgent: ANDROID_UA, init: "Object.defineProperty(window, 'isSecureContext', { get: () => false });" });
        try {
          await open('more/install');
          assert.equal(await p.evaluate('isSecureContext'), false, 'insecure context emulated');
          await p.getByRole('heading', { name: 'Needs a secure connection' }).waitFor();
          await p.getByText(/reverse proxy/).waitFor();
          await install.address(p);
          assert.equal(await overflows(p), false);
        } finally { await ctx.close(); }
      }
    });

    await t.test('on a phone, loading shows a skeleton and a failed load offers Try again', async () => {
      const { ctx, p, phoneAxe } = await phonePage({ lenient: true });
      try {
        let release: () => void = () => undefined;
        const held = new Promise<void>((r) => { release = r; });
        await p.route('**/v1/admin/users', async (r) => { await held; await r.continue(); });
        await p.goto(`${base}/#/admin/users`);
        const skel = p.getByRole('status').filter({ hasText: 'Loading accounts' });
        await skel.waitFor();
        assert.equal(await skel.getAttribute('aria-busy'), 'true');
        release();
        await skel.waitFor({ state: 'detached' });
        await p.getByText(FRIEND.email).waitFor();
        await p.unroute('**/v1/admin/users');

        await p.route('**/v1/admin/users', (r) => r.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad gateway' }));
        await p.goto('about:blank');
        await p.goto(`${base}/#/admin/users`);
        const alert = p.getByRole('alert').filter({ hasText: 'Can’t reach' });
        await alert.waitFor();
        await alert.getByText('Details for your admin').click();
        await alert.getByText(/HTTP 502/).waitFor();
        assert.equal(await overflows(p), false);
        assert.deepEqual(await bothThemes(p, phoneAxe, 'error state'), []);
        await p.unroute('**/v1/admin/users');
        await alert.getByRole('button', { name: 'Try again' }).click();
        await p.getByText(FRIEND.email).waitFor();
      } finally { await ctx.close(); }
    });

    await t.test('on a phone, going offline shows the pill and banner and pauses saving', async () => {
      const { ctx, p, phoneAxe, open } = await phonePage({ lenient: true });
      try {
        await open('settings/profile');
        await p.evaluate('navigator.serviceWorker.ready.then(() => undefined)');
        let profileSaves = 0;
        p.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/v1/auth/account')) profileSaves++; });
        await ctx.setOffline(true);
        const banner = p.getByRole('complementary', { name: 'App status' }).getByText('You’re offline.');
        await banner.waitFor();
        await p.locator('.m-conn').getByText(/^Offline · loaded at /).waitFor();
        assert.equal(await overflows(p), false);
        const findings: string[] = [];
        for (const colorScheme of ['light', 'dark'] as const) {
          await p.emulateMedia({ colorScheme });
          await p.waitForTimeout(1000); // let colour transitions settle before measuring contrast
          findings.push(...await phoneAxe(`offline ${colorScheme}`));
        }
        assert.deepEqual(findings, []);
        // Saving is refused with an explanation; nothing is sent.
        await p.getByLabel('Display name').fill('Offline edit');
        await p.getByRole('button', { name: 'Save profile' }).click();
        await toastSays(p, /You’re offline\. Saving needs a connection/);
        assert.equal(profileSaves, 0, 'no request while offline');
        // The banner can be dismissed; the pill stays until the connection returns.
        await p.getByRole('button', { name: 'Dismiss' }).click();
        await banner.waitFor({ state: 'hidden' });
        assert.equal(await p.locator('.m-conn').isVisible(), true);
        await ctx.setOffline(false);
        await toastSays(p, 'You’re back online.');
        await p.locator('.m-conn').waitFor({ state: 'hidden' });

        // A cold start offline (the worker serves the shell) says so instead of showing sign-in, and recovers by itself.
        for (let i = 0; i < 80 && !(await p.evaluate('!!navigator.serviceWorker.controller')); i++) await p.waitForTimeout(100);
        await ctx.setOffline(true);
        await p.reload();
        await p.getByRole('heading', { name: 'You’re offline', level: 1 }).waitFor();
        assert.equal(await p.getByRole('heading', { name: 'Sign in' }).count(), 0);
        await ctx.setOffline(false);
        await p.getByRole('heading', { name: 'Profile', level: 1 }).waitFor();
      } finally { await ctx.close(); }
    });

    await t.test('on a phone, an update waits for the fill-up sheet and reloads only when asked', async () => {
      const { ctx, p, phoneAxe } = await phonePage();
      // A second build of the client: one changed byte gives the service worker a new build id.
      const dir = mkdtempSync(path.join(tmpdir(), 'driveloom-web-'));
      cpSync(WEB, dir, { recursive: true });
      appendFileSync(path.join(dir, 'sw.js'), '\n// next build\n');
      const original = handler;
      try {
        await p.goto(`${base}/#/${vehicle}`);
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        await p.evaluate('navigator.serviceWorker.ready.then(() => undefined)');
        for (let i = 0; i < 80 && !(await p.evaluate('!!navigator.serviceWorker.controller')); i++) await p.waitForTimeout(100);
        assert.equal(await p.evaluate('!!navigator.serviceWorker.controller'), true, 'the worker controls the page');
        await p.evaluate('window.__sameDocument = true');

        // Typing a fill-up when the update arrives: no banner until the sheet closes.
        await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fill up' }).click();
        const sheet = p.getByRole('dialog', { name: 'Add a fill-up' });
        await sheet.getByLabel('Fuel', { exact: true }).fill('20');
        handler = createApplication(deps, { webDir: dir });
        await p.evaluate('navigator.serviceWorker.getRegistration().then((r) => r.update())');
        for (let i = 0; i < 80 && !(await p.evaluate('navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)')); i++) await p.waitForTimeout(100);
        assert.equal(await p.evaluate('navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)'), true, 'a new worker is waiting');
        await p.waitForTimeout(1800);
        const banner = p.getByRole('complementary', { name: 'App status' }).getByText('Update available');
        assert.equal(await banner.isVisible(), false, 'held back while the fill-up sheet is open');
        await sheet.getByRole('button', { name: 'Cancel' }).click();
        await p.getByRole('button', { name: 'Discard' }).click();
        await sheet.waitFor({ state: 'detached' });
        await banner.waitFor();
        assert.equal(await p.evaluate('window.__sameDocument === true'), true, 'no reload by itself');
        assert.equal(await overflows(p), false);
        assert.deepEqual(await bothThemes(p, phoneAxe, 'update banner'), []);
        assert.equal(await p.evaluate('window.__sameDocument === true'), true, 'still no reload by itself');
        // Reload is the only way in: the new worker takes over and the page reloads once.
        await p.getByRole('button', { name: 'Reload' }).click();
        const until = Date.now() + 8000;
        while (await p.evaluate('window.__sameDocument === true').catch(() => true)) {
          assert.ok(Date.now() < until, 'no reload after tapping Reload');
          await new Promise((r) => setTimeout(r, 50));
        }
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        assert.equal(await p.getByRole('complementary', { name: 'App status' }).getByText('Update available').isVisible(), false);
      } finally {
        handler = original;
        await ctx.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await t.test('on a phone, sign-in is full screen with phone keyboards and returns to the route', async () => {
      const { ctx, p, phoneAxe } = await phonePage({ signedIn: false });
      try {
        await p.goto(`${base}/#/friends`);
        await p.getByRole('heading', { name: 'Sign in' }).waitFor();
        assert.equal(await p.getByRole('navigation', { name: 'Main' }).isVisible(), false, 'no tab bar');
        await p.getByText(new URL(base).host).waitFor();
        const email = p.getByLabel('Email', { exact: true });
        assert.equal(await email.getAttribute('type'), 'email');
        assert.equal(await email.getAttribute('autocomplete'), 'username');
        assert.equal(await email.getAttribute('autocapitalize'), 'none');
        assert.equal(await email.getAttribute('spellcheck'), 'false');
        assert.equal(await p.getByLabel('Password').getAttribute('autocomplete'), 'current-password');
        // Passkey leads when the browser has one; the password follows.
        const order = await p.evaluate(`[...document.querySelectorAll('main button')].map((b) => b.textContent.trim()).filter((t) => /sign in/i.test(t))`) as string[];
        assert.equal(order[0], 'Sign in with a passkey');
        assert.equal(order.at(-1), 'Sign in');
        await p.getByText('or use your password').waitFor();
        const findings: string[] = [];
        for (const colorScheme of ['light', 'dark'] as const) {
          await p.emulateMedia({ colorScheme });
          await p.reload();
          await p.getByRole('heading', { name: 'Sign in' }).waitFor();
          await p.waitForTimeout(500);
          findings.push(...await phoneAxe(`sign-in ${colorScheme}`));
          assert.equal(await overflows(p), false);
        }
        // The second step: a numeric one-time code, switchable to a recovery code.
        await p.goto(`${base}/#/mfa`);
        await p.getByRole('heading', { name: 'Two-step verification' }).waitFor();
        const code = p.getByLabel('Authenticator code');
        assert.equal(await code.getAttribute('inputmode'), 'numeric');
        assert.equal(await code.getAttribute('autocomplete'), 'one-time-code');
        await p.getByRole('button', { name: 'Use a recovery code instead' }).click();
        assert.equal(await p.getByLabel('Recovery code').getAttribute('inputmode'), 'text');
        assert.equal(await overflows(p), false, '#/mfa overflows');
        findings.push(...await bothThemes(p, phoneAxe, '#/mfa'));
        for (const hash of ['register', 'recover']) {
          await p.goto(`${base}/#/${hash}`);
          await p.locator('main h1').waitFor();
          assert.equal(await overflows(p), false, `#/${hash} overflows`);
          findings.push(...await phoneAxe(`#/${hash}`));
        }
        assert.deepEqual(findings, []);
        // Signing in where sign-in interrupted (#/friends) comes back there.
        await p.goto(`${base}/#/friends`);
        await p.getByRole('heading', { name: 'Sign in' }).waitFor();
        await p.getByLabel('Email', { exact: true }).fill(ADMIN.email);
        await p.getByLabel('Password').fill(ADMIN.password);
        await p.getByRole('button', { name: 'Sign in', exact: true }).click();
        await p.getByRole('heading', { name: 'Friends', level: 1 }).waitFor();
        assert.match(p.url(), /#\/friends$/);
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

    await t.test('the service worker caches the shell, never an API response, and sign-out clears it', async () => {
      // localhost is a secure context, so the worker registers.
      await page.goto(`${base}/#/`);
      // The page runs in a browser; the test's TypeScript has no DOM types, so the snippets are strings.
      // Earlier sign-outs emptied the caches by design, so start from a fresh install.
      await page.evaluate('navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(() => caches.keys()).then((ks) => Promise.all(ks.map((k) => caches.delete(k))))');
      await page.reload();
      await page.evaluate('navigator.serviceWorker.ready.then(() => undefined)');
      await page.waitForFunction("caches.keys().then((k) => Promise.all(k.map((n) => caches.open(n).then((c) => c.match('/js/pwa.js'))))).then((r) => r.some(Boolean))");
      await page.evaluate("fetch('/v1/auth/session').then((r) => r.text())");
      const cached = await page.evaluate(`(async () => {
        const out = [];
        for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
        return out;
      })()`) as string[];
      assert.ok(cached.includes('/') && cached.includes('/styles.css') && cached.includes('/js/pwa.js'), cached.join(' '));
      assert.deepEqual(cached.filter((p) => p.startsWith('/v1/')), [], 'no API response is cached');
      await page.getByRole('button', { name: /sign out/i }).click();
      await page.getByRole('heading', { name: 'Sign in' }).waitFor();
      await page.waitForFunction('caches.keys().then((k) => k.length === 0)');
    });

    assert.deepEqual(problems, [], 'no console errors, page errors or CSP violations');
  } finally {
    await browser.close();
    server.close(); server.closeAllConnections();
    await db.drop();
  }
});
