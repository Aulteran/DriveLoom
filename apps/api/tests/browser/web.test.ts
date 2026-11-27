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
// A real 1x1 PNG and a minimal PDF, for the attachment journeys.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const TINY_PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
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

    await t.test('make and model suggest but never constrain: custom text saves verbatim, a suggestion fills its name, a failed lookup changes nothing', async () => {
      const api = (call: string) => page.evaluate(`import('/js/api.js').then((m) => m.${call})`) as Promise<any>;
      const made: string[] = [];
      const add = async () => {
        await page.goto(`${base}/#/garage`);
        await page.getByRole('heading', { name: 'Garage', level: 1 }).waitFor();
        await page.getByRole('button', { name: 'Add vehicle' }).first().click();
        return page.locator('form', { hasText: 'Add a vehicle' });
      };
      const submit = async () => {
        await page.locator('form').getByRole('button', { name: 'Add vehicle' }).click();
        await page.waitForURL(/#\/vehicles\/[0-9a-f-]{36}/);
        const id = new URL(page.url()).hash.split('/')[2]!;
        made.push(id);
        return await api(`get('/v1/vehicles/${id}')`);
      };
      const rows = async () => (await db.pool.query('SELECT id, make, model FROM vehicles ORDER BY id')).rows;
      try {
        // Custom text, no suggestion matches: saved exactly as typed.
        let f = await add();
        await f.getByLabel('Make').fill('Zorblax');
        await f.getByLabel('Model').fill('Custom One');
        await f.getByLabel('Year').fill('2015');
        const custom = await submit();
        assert.deepEqual([custom.make, custom.model, custom.year], ['Zorblax', 'Custom One', 2015]);

        // A suggestion: typing a prefix offers the canonical name; choosing it puts that name in the field.
        f = await add();
        const make = f.getByLabel('Make'), model = f.getByLabel('Model');
        await make.click();
        await make.pressSequentially('hon');
        await page.locator(`datalist[id="${await make.getAttribute('list')}"] option[value="Honda"]`).waitFor({ state: 'attached' });
        assert.deepEqual(await axe('add vehicle with suggestions'), []);
        await make.fill('Honda');
        await model.click();
        await model.pressSequentially('ody');
        await page.locator(`datalist[id="${await model.getAttribute('list')}"] option[value="Odyssey"]`).waitFor({ state: 'attached' });
        await model.fill('Odyssey');
        await f.getByLabel('Year').fill('2015');
        const picked = await submit();
        assert.deepEqual([picked.make, picked.model], ['Honda', 'Odyssey']);

        // An alias typed as free text is still saved as typed (never rewritten to the canonical name).
        f = await add();
        await f.getByLabel('Make').fill('chevy');
        await f.getByLabel('Model').fill('Silverado LT');
        const alias = await submit();
        assert.deepEqual([alias.make, alias.model], ['chevy', 'Silverado LT']);

        // The lookup failing leaves plain inputs that work as before.
        await page.route('**/v1/vehicle-identities*', (r) => r.abort());
        f = await add();
        await f.getByLabel('Make').pressSequentially('Ren');
        await f.getByLabel('Model').pressSequentially('Clio V');
        const offline = await submit();
        assert.deepEqual([offline.make, offline.model], ['Ren', 'Clio V']);
        await page.unroute('**/v1/vehicle-identities*');
        // The aborted lookups are expected to log failed loads; nothing else may.
        for (let i = problems.length - 1; i >= 0; i--) if (problems[i] === 'console: Failed to load resource: net::ERR_FAILED') problems.splice(i, 1);

        // Editing: the stored text shows as it is, and saving without touching it rewrites nothing.
        await page.goto(`${base}/#/vehicles/${alias.id}/settings`);
        await page.reload();
        await page.getByLabel('Make').waitFor();
        assert.equal(await page.getByLabel('Make').inputValue(), 'chevy');
        const snapshot = await rows();
        await page.getByRole('button', { name: /^Save/ }).first().click();
        await page.getByText('Saved').first().waitFor().catch(() => undefined);
        assert.deepEqual((await rows()).map((r) => [r.id, r.make, r.model]), snapshot.map((r) => [r.id, r.make, r.model]));
      } finally {
        if (made.length) await db.pool.query('DELETE FROM vehicles WHERE id = ANY($1)', [made]);
        await page.goto(`${base}/#/${vehicle}`);
        await page.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
      }
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
        // The stylesheet promises that a theme switch is instant: no text or background colour may fade,
        // or axe would measure a half-way blend (this failed intermittently in CI before).
        const fading = await page.evaluate(`document.getAnimations()
          .filter((a) => a instanceof CSSTransition && ['color', 'background-color'].includes(a.transitionProperty)).length`);
        assert.equal(fading, 0, `switching to ${colorScheme} must not fade text or background colours`);
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
        await p.getByRole('heading', { name: 'History', level: 1 }).waitFor();
        assert.match(p.url(), /#\/vehicles\/[0-9a-f-]{36}\/log$/);
        assert.notEqual(p.url().split('#/')[1], `${vehicle}/log`, 'History follows the active vehicle');

        // Fill up opens its sheet over the current screen and closes back to it.
        await tab('Fill up').click();
        const fill = p.getByRole('dialog', { name: 'Add a fill-up' });
        await fill.waitFor();
        await p.keyboard.press('Escape');
        await fill.waitFor({ state: 'detached' });
        await p.waitForURL(/\/log$/);
        await p.getByRole('heading', { name: 'History', level: 1 }).waitFor();

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
        await p.getByRole('heading', { name: 'History', level: 1 }).waitFor();
        await p.locator('main .m-fill-row').first().getByText('11650 km').waitFor();
        assert.match(await p.locator('main .m-fill-row').first().innerText(), new RegExp(expected.split(' ')[0]!.replace('.', '\\.')));

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
        await p.getByRole('heading', { name: 'History', level: 1 }).waitFor();
      } finally { await ctx.close(); }
    });

    await t.test('on a phone, Home, History and Vehicles are phone-native screens', async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
      const p = watch(await ctx.newPage());
      p.setDefaultTimeout(8000);
      const phoneAxe = async (label: string) => (await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze())
        .violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      const open = async (hash: string) => {
        await p.goto('about:blank');
        await p.goto(`${base}/#/${hash}`);
        await p.waitForLoadState('networkidle');
        await p.locator('main h1').first().waitFor();
      };
      const rows = p.locator('main .m-fill-row');
      const findings: string[] = [];
      try {
        // Home: the latest tank, the trend, the figures and the last fill-ups.
        await open(vehicle);
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        for (const name of ['Latest tank', 'Economy trend', 'Recent fill-ups']) await p.getByRole('heading', { name, exact: false }).first().waitFor();
        await p.locator('main .m-big').getByText(/^\d+\.\d\d$/).waitFor();
        for (const k of ['Spent', 'Distance', 'Fuel', 'Cost per distance', 'Fill-ups']) await p.locator('main dt', { hasText: k }).first().waitFor();
        assert.equal(await rows.count(), 3, 'three recent fill-ups');
        assert.equal(await overflows(p), false, 'Home overflows');
        // The period selector is a row of links.
        await p.getByRole('navigation', { name: 'Period' }).getByRole('link', { name: 'All time' }).click();
        await p.waitForURL(/window=all/);
        await p.locator('main .m-seg-opt[aria-current="true"]', { hasText: 'All' }).waitFor();
        await p.waitForLoadState('networkidle');

        // The chart: tap a point or step with buttons; the readout says the value; a table is the text alternative.
        const readout = p.locator('main .m-chart-readout').first();
        const last = await readout.innerText();
        assert.match(last, /mpg \(US\)/);
        await p.getByRole('button', { name: 'Previous interval' }).first().click();
        assert.notEqual(await readout.innerText(), last);
        const box = (await p.locator('main .m-chart-plot').first().boundingBox())!;
        await p.mouse.click(box.x + box.width - 16, box.y + box.height / 2);
        assert.equal(await readout.innerText(), last, 'a tap near the last point picks it');
        assert.equal(await p.getByRole('button', { name: 'Next interval' }).first().isDisabled(), true);
        assert.match(await p.locator('main svg[role="img"]').first().getAttribute('aria-label') ?? '', /^Economy in mpg \(US\) for 3 intervals/);
        await p.locator('main .chart-data summary').first().click();
        assert.equal(await p.locator('main .chart-data tbody tr').first().locator('td').count(), 2);

        // History: compact rows, filter chips, an empty filter result.
        await p.getByRole('link', { name: 'See all' }).click();
        await p.getByRole('heading', { name: 'History', level: 1 }).waitFor();
        await rows.nth(3).waitFor();
        assert.equal(await rows.count(), 4);
        assert.equal(await overflows(p), false, 'History overflows');
        await p.getByRole('button', { name: 'Partial' }).click();
        await p.waitForURL(/type=partial/);
        await p.getByRole('heading', { name: 'No fill-ups match' }).waitFor();
        assert.equal(await p.getByRole('button', { name: 'Partial' }).getAttribute('aria-pressed'), 'true');
        await p.getByRole('link', { name: 'Show all fill-ups' }).click();
        await p.waitForURL(/\/log$/);
        await rows.nth(3).waitFor();
        await p.getByRole('button', { name: /^Period: / }).click();
        await p.getByRole('dialog', { name: 'Period' }).getByRole('button', { name: 'Last 30 days' }).click();
        await p.waitForURL(/period=30/);
        await p.getByRole('button', { name: 'Period: Last 30 days' }).waitFor();
        await rows.first().waitFor();
        assert.equal(await rows.count(), 3, 'the fill-up 40 days ago is outside the last 30 days');

        // The detail sheet; Edit reopens the fill-up sheet prefilled and saves with explicit buttons.
        await open(`${vehicle}/log`);
        await rows.first().click();
        const detail = p.getByRole('dialog').filter({ hasText: 'Odometer' });
        await detail.getByText('11650 km').waitFor();
        await detail.getByText('Interval').waitFor();
        assert.equal(await overflows(p), false, 'the detail sheet overflows');
        for (const colorScheme of ['dark', 'light'] as const) {
          await p.emulateMedia({ colorScheme });
          await p.waitForTimeout(300);
          findings.push(...await phoneAxe(`detail sheet ${colorScheme}`));
        }
        assert.deepEqual(findings, []);
        await detail.getByRole('button', { name: 'Edit' }).click();
        const edit = p.getByRole('dialog', { name: 'Edit fill-up' });
        await edit.waitFor();
        assert.equal(await edit.getByLabel('Odometer', { exact: true }).inputValue(), '11650');
        assert.equal(await edit.getByLabel('Fuel', { exact: true }).inputValue(), '35.5');
        await edit.getByLabel('Fuel', { exact: true }).fill('36');
        await edit.getByRole('button', { name: 'Save changes' }).click();
        await edit.waitFor({ state: 'detached' });
        await p.locator('#toast').getByText('Fill-up updated', { exact: false }).waitFor();
        await rows.first().getByText(/^36(\.0+)? L/).waitFor();
        assert.equal(await rows.count(), 4, 'an edit adds no record');

        // Delete asks in a second sheet that names the date; Cancel keeps it, Delete removes it.
        await rows.first().click();
        await detail.getByRole('button', { name: 'Delete' }).click();
        const confirm = p.getByRole('dialog', { name: 'Delete this fill-up?' });
        await confirm.getByText('will be removed').waitFor();
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await confirm.waitFor({ state: 'detached' });
        await detail.getByRole('button', { name: 'Delete' }).click();
        await confirm.getByRole('button', { name: 'Delete fill-up' }).click();
        await p.locator('#toast').getByText('Fill-up deleted.').waitFor();
        await rows.nth(3).waitFor({ state: 'detached' });
        assert.equal(await rows.count(), 3);
        assert.equal(await p.locator('dialog[open]').count(), 0, 'every sheet closed');

        // Vehicles: the active vehicle is marked; a row opens the detail hub with chart, monthly cost and sections.
        await open('garage');
        await p.getByRole('heading', { name: 'Vehicles', level: 1 }).waitFor();
        const golfRow = p.locator('main a.m-vrow', { hasText: 'Golf' });
        assert.equal(await golfRow.getAttribute('aria-current'), 'true');
        await golfRow.getByText('Active').waitFor();
        const clio = (await p.locator('main a.m-vrow', { hasText: 'Clio' }).getAttribute('href'))!.split('/')[2]!;
        await p.getByRole('button', { name: 'Add a vehicle' }).first().click();
        const add = p.getByRole('dialog', { name: 'Add a vehicle' });
        await add.getByLabel('Nickname (optional)').waitFor();
        assert.equal(await overflows(p), false, 'the add sheet overflows');
        await p.keyboard.press('Escape');
        await add.waitFor({ state: 'detached' });
        await golfRow.click();
        await p.waitForURL(/\/overview$/);
        await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
        for (const name of ['Economy', 'Monthly cost', 'This vehicle']) await p.getByRole('heading', { name, exact: true }).waitFor();
        await p.getByText('Active vehicle for Home, History and Fill up').waitFor();
        assert.equal(await overflows(p), false, 'the detail hub overflows');
        await p.getByRole('link', { name: /^Members/ }).click();
        await p.getByRole('heading', { name: 'Members', level: 1 }).waitFor();
        await p.locator('main').getByText(ADMIN.email).first().waitFor();
        await p.getByRole('button', { name: 'Add a member' }).click();
        await p.getByRole('dialog', { name: 'Share this vehicle' }).getByLabel('Email').waitFor();
        await p.keyboard.press('Escape');
        await p.locator('main a.m-back').click();
        await p.getByRole('link', { name: /^Import & export/ }).click();
        await p.getByRole('button', { name: /^Download CSV/ }).waitFor();
        await p.getByRole('button', { name: /^Import fill-ups/ }).click();
        await p.getByRole('dialog', { name: 'Import fill-ups' }).getByLabel('File').waitFor();
        await p.keyboard.press('Escape');
        await open(`${vehicle}/settings`);
        await p.getByRole('heading', { name: 'Vehicle settings', level: 1 }).waitFor();
        assert.equal(await p.getByRole('switch', { name: 'Share this vehicle’s economy with my friends' }).isChecked(), true, 'the desktop opt-in shows here');
        await p.getByRole('button', { name: /^Details/ }).click();
        assert.equal(await p.getByRole('dialog', { name: 'Vehicle details' }).getByLabel('Nickname (optional)').inputValue(), 'Golf');
        const details = p.getByRole('dialog', { name: 'Vehicle details' });
        assert.equal(await details.getByLabel('Make').inputValue(), 'VW', 'stored text is shown as saved');
        const dl = await details.getByLabel('Make').getAttribute('list');
        await details.getByLabel('Make').click();
        await details.getByLabel('Make').fill('vol');
        await p.locator(`datalist[id="${dl}"] option[value="Volkswagen"]`).waitFor({ state: 'attached' });
        await details.getByLabel('Make').fill('VW');
        await p.keyboard.press('Escape');

        // Empty states: the second vehicle has no fill-ups.
        await open(`vehicles/${clio}`);
        await p.getByRole('heading', { name: 'No fill-ups yet' }).waitFor();
        await p.getByRole('link', { name: 'Log a fill-up' }).waitFor();
        await open(`vehicles/${clio}/log`);
        await p.getByRole('heading', { name: 'No fill-ups yet' }).waitFor();

        // Every screen fits and passes axe in both themes.
        const screenFindings: string[] = [];
        const screens = [vehicle, `${vehicle}/log`, `vehicles/${clio}`, `vehicles/${clio}/log`, 'garage', `${vehicle}/overview`, `${vehicle}/members`, `${vehicle}/data`, `${vehicle}/settings`];
        for (const colorScheme of ['light', 'dark'] as const) {
          await p.emulateMedia({ colorScheme });
          for (const hash of screens) {
            await open(hash);
            assert.equal(await overflows(p), false, `#/${hash} overflows (${colorScheme})`);
            await p.waitForTimeout(200);
            screenFindings.push(...await phoneAxe(`phone ${colorScheme} #/${hash}`));
          }
        }
        assert.deepEqual(screenFindings, []);

        // A vehicle becomes the active one from its detail hub.
        await open(`vehicles/${clio}/overview`);
        await p.getByRole('button', { name: 'Set as active vehicle' }).click();
        await p.waitForURL(new RegExp(`#/vehicles/${clio}$`));
        await p.getByRole('button', { name: 'Vehicle: Clio', exact: true }).waitFor();
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
    const phonePage = async (opts: { signedIn?: boolean; userAgent?: string; init?: string; lenient?: boolean; viewport?: { width: number; height: number }; touch?: boolean } = {}) => {
      const ctx = await browser.newContext({
        viewport: opts.viewport ?? { width: 390, height: 844 }, ...(opts.touch ? { hasTouch: true, isMobile: true } : {}), ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
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
      // Layout heights once finite animations are done: the screen's entrance animation (a translate)
      // makes transformed bounding boxes read 43.99998px mid-flight.
      const heights = await p.evaluate(`Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)))
        .then(() => [...document.querySelectorAll('.m-seg button, .m-seg .m-seg-opt')].map((b) => b.offsetHeight))`) as number[];
      assert.ok(heights.length > 0, 'no segmented control on screen');
      for (const h of heights) assert.ok(h >= 44, `segmented button under 44px (${h})`);
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

    /** Every request URL path held by any cache, in this page's origin. */
    const cachedPaths = (p: Page) => p.evaluate(`(async () => {
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname + new URL(r.url).search);
      return out;
    })()`) as Promise<string[]>;
    const controlled = async (p: Page) => {
      await p.evaluate('navigator.serviceWorker.ready.then(() => undefined)');
      for (let i = 0; i < 80 && !(await p.evaluate('!!navigator.serviceWorker.controller')); i++) await p.waitForTimeout(100);
      assert.equal(await p.evaluate('!!navigator.serviceWorker.controller'), true, 'the worker controls the page');
    };
    const inPhoneShell = (p: Page) => p.evaluate("document.body.classList.contains('m-shell')");

    /** Polls a page expression until it is true. (Page.waitForFunction would need 'unsafe-eval', which the CSP forbids.) */
    const until = async (p: Page, expr: string, timeout = 8000) => {
      const end = Date.now() + timeout;
      while (!(await p.evaluate(expr).catch(() => false))) {
        assert.ok(Date.now() < end, `timed out waiting for: ${expr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await t.test('on a desktop, a changed client arrives on the next reload with no banner, and an offline reload still renders the cached shell', async () => {
      const { ctx, p } = await phonePage({ lenient: true, viewport: { width: 1100, height: 900 } });
      // A second build of the client with one changed web file.
      const dir = mkdtempSync(path.join(tmpdir(), 'driveloom-web-'));
      cpSync(WEB, dir, { recursive: true });
      appendFileSync(path.join(dir, 'js/main.js'), '\n// NEW-BUILD-MARKER\n');
      const original = handler;
      try {
        await p.goto(`${base}/#/settings/profile`);
        await p.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
        await controlled(p);
        assert.equal(await inPhoneShell(p), false, 'the desktop shell');
        await p.evaluate('window.__sameDocument = true');
        // Authenticated API calls go straight to the network: no cache ever holds a /v1 request.
        await p.evaluate("Promise.all(['/v1/vehicles', '/v1/preferences', '/v1/auth/session'].map((u) => fetch(u).then((r) => r.text())))");
        const before = await cachedPaths(p);
        assert.ok(before.includes('/js/main.js'), before.join(' '));
        assert.deepEqual(before.filter((x) => x.includes('/v1')), [], 'no API request is cached');
        assert.equal(await p.evaluate("fetch('/js/main.js').then((r) => r.text()).then((t) => t.includes('NEW-BUILD-MARKER'))"), false);

        // Deploy: the worker updates and waits (the file list is the same, so it is only a new build id).
        handler = createApplication(deps, { webDir: dir });
        await p.evaluate('navigator.serviceWorker.getRegistration().then((r) => r.update())');
        for (let i = 0; i < 80 && !(await p.evaluate('navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)')); i++) await p.waitForTimeout(100);
        assert.equal(await p.evaluate('navigator.serviceWorker.getRegistration().then((r) => !!r.waiting)'), true, 'a new worker is waiting');

        // One reload in the same tab, no banner and no tab closed: the new file is what runs.
        await p.reload();
        await p.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
        assert.equal(await p.evaluate('window.__sameDocument === true'), false, 'the page did reload');
        assert.equal(await p.evaluate("fetch('/js/main.js').then((r) => r.text()).then((t) => t.includes('NEW-BUILD-MARKER'))"), true, 'the new main.js is served');
        assert.equal(await p.evaluate("caches.match('/js/main.js').then((r) => r.text()).then((t) => t.includes('NEW-BUILD-MARKER'))"), true, 'and the cached copy follows it');
        assert.equal(await p.getByText('Update available').count(), 0, 'no banner on a desktop');
        assert.deepEqual((await cachedPaths(p)).filter((x) => x.includes('/v1')), []);

        // Offline cold start: the cached shell loads and runs; it says it is unreachable instead of a browser error page.
        await ctx.setOffline(true);
        await p.reload();
        await until(p, "document.querySelector('#main, main')?.textContent?.trim().length > 0 && !!document.querySelector('link[href=\"/styles.css\"]')");
        assert.equal(await p.evaluate("document.title.length > 0 && !!document.querySelector('script[src=\"/js/boot.js\"]')"), true, 'the cached index.html was served');
        assert.equal(await p.evaluate("typeof window.__sameDocument"), 'undefined', 'a fresh document');
        assert.ok(await p.locator('body').innerText().then((x) => x.length > 20), 'something rendered');
        await ctx.setOffline(false);
      } finally {
        handler = original;
        await ctx.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    await t.test('crossing the phone width keeps unsaved input and open dialogs, and switches shells when nothing would be lost', async () => {
      // Typed text survives 1100 -> 683 until it is cleared.
      {
        const { ctx, p } = await phonePage({ lenient: true, viewport: { width: 1100, height: 900 } });
        try {
          await p.goto(`${base}/#/settings/profile`);
          const name = p.getByLabel('Display name');
          await name.waitFor();
          const original = await name.inputValue();
          await p.evaluate('window.__sameDocument = true');
          await name.fill('Typed but unsaved');
          await p.setViewportSize({ width: 683, height: 800 });
          await p.waitForTimeout(2600); // past the 2 s re-check
          assert.equal(await p.evaluate('window.__sameDocument === true'), true, 'no reload over typed text');
          assert.equal(await inPhoneShell(p), false);
          assert.equal(await name.inputValue(), 'Typed but unsaved');
          await name.fill(original);
          await until(p, "document.body.classList.contains('m-shell')");
          assert.equal(await p.evaluate('window.__sameDocument === true'), false, 'reloaded once clean');
        } finally { await ctx.close(); }
      }
      // An open sheet survives 390 -> 1100 until it closes.
      {
        const { ctx, p } = await phonePage({ lenient: true });
        try {
          await p.goto(`${base}/#/${vehicle}`);
          await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
          await p.evaluate('window.__sameDocument = true');
          await p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Fill up' }).click();
          const sheet = p.getByRole('dialog', { name: 'Add a fill-up' });
          await sheet.waitFor();
          await p.setViewportSize({ width: 1100, height: 900 });
          await p.waitForTimeout(2600);
          assert.equal(await p.evaluate('window.__sameDocument === true'), true, 'no reload under an open dialog');
          assert.equal(await sheet.isVisible(), true);
          await sheet.getByRole('button', { name: 'Cancel' }).click();
          await sheet.waitFor({ state: 'detached' });
          await until(p, "!document.body.classList.contains('m-shell')");
        } finally { await ctx.close(); }
      }
      // With nothing typed, a normal resize switches shells both ways at once (the vehicle page has a select).
      {
        const { ctx, p } = await phonePage({ lenient: true, viewport: { width: 1100, height: 900 } });
        try {
          await p.goto(`${base}/#/${vehicle}`);
          await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
          assert.equal(await inPhoneShell(p), false);
          await p.setViewportSize({ width: 683, height: 800 });
          await until(p, "document.body.classList.contains('m-shell')", 1900);
          await p.getByRole('heading', { name: 'Golf', level: 1 }).waitFor();
          await p.setViewportSize({ width: 1100, height: 900 });
          await until(p, "!document.body.classList.contains('m-shell')", 1900);
        } finally { await ctx.close(); }
      }
      // A phone on its side (844x390, touch) is still a phone; a short desktop window with a mouse is not.
      {
        const { ctx, p } = await phonePage({ lenient: true, viewport: { width: 844, height: 390 }, touch: true });
        try {
          await p.goto(`${base}/#/`);
          await until(p, "document.body.classList.contains('m-shell')");
          await p.setViewportSize({ width: 390, height: 844 });
          await p.waitForTimeout(500);
          await p.setViewportSize({ width: 844, height: 390 });
          await p.waitForTimeout(2600);
          assert.equal(await inPhoneShell(p), true, 'landscape on a touch phone keeps the phone shell');
          assert.equal(await p.getByRole('navigation', { name: 'Main' }).isVisible(), true);
        } finally { await ctx.close(); }
        const desk = await phonePage({ lenient: true, viewport: { width: 844, height: 390 } });
        try {
          await desk.p.goto(`${base}/#/`);
          await desk.p.locator('#sidebar .side-nav').first().waitFor({ state: 'attached' });
          assert.equal(await inPhoneShell(desk.p), false, 'a short window with a mouse keeps the desktop shell');
        } finally { await desk.ctx.close(); }
      }
    });

    await t.test('service history: off by default, then a desktop visit is added, corrected and deleted', async () => {
      // Off: no menu entry, and the page says so instead of failing.
      await page.goto(`${base}/#/${vehicle}`);
      await page.getByRole('heading', { name: 'At a glance' }).waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Vehicle' }).getByRole('link', { name: 'Service' }).count(), 0);
      await page.goto(`${base}/#/${vehicle}/service`);
      await page.getByText('The Service module is not enabled on this server.').waitFor();

      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      await page.goto(`${base}/#/${vehicle}`);
      await page.reload();
      await page.getByRole('heading', { name: 'At a glance' }).waitFor();
      await page.getByRole('navigation', { name: 'Vehicle' }).getByRole('link', { name: 'Service' }).click();
      await page.getByRole('heading', { name: 'Service', level: 1 }).waitFor();
      await page.getByText('Start from today. Adding past service is optional.').waitFor();
      assert.deepEqual(await axe('service empty'), []);

      await page.getByRole('button', { name: 'Add service visit' }).click();
      await page.getByLabel('Date of service').waitFor();
      await page.getByLabel('Date of service').fill('2026-03-14');
      await page.getByLabel('Odometer reading').fill('45210');
      await page.getByLabel('Provider (optional)').fill('Corner Garage');
      await page.getByLabel('Item', { exact: true }).first().fill('Oil change');
      await page.getByRole('button', { name: 'Add another item' }).click();
      await page.getByLabel('Item', { exact: true }).nth(1).fill('Wipers');
      await page.getByLabel(/^Cost \(.*optional\)$/).first().fill('0');
      await page.getByLabel(/^Total cost for the visit/).fill('89.50');
      assert.deepEqual(await axe('service form'), []);
      // A receipt picked while adding is uploaded with the visit; an unsuitable file is explained, not sent.
      await page.getByRole('button', { name: 'Choose files to attach to this service visit' }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Take photo/ }).count(), 0, 'no camera button on desktop');
      await page.locator('.svc-form input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
      await page.getByText('"notes.txt" is not a PDF, JPEG or PNG file.').waitFor();
      await page.locator('.svc-form input[type=file]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: TINY_PNG });
      await page.getByRole('list', { name: 'Files to attach' }).getByText('receipt.png').waitFor();
      assert.deepEqual(await axe('service form with a file'), []);
      await page.getByRole('button', { name: 'Add visit' }).click();
      const card = page.locator('article.svc-visit').first();
      await card.waitFor();
      await card.getByText('Oil change').waitFor();
      await card.getByText('Wipers').waitFor();
      assert.match(await card.innerText(), /89\.50/);
      assert.match(await card.innerText(), /Corner Garage/);
      assert.deepEqual(await axe('service list'), []);

      // Attachments: the staged receipt arrived; add a PDF to the saved visit, preview, rename, remove.
      await card.getByRole('list', { name: 'Attachments' }).getByText('receipt.png').waitFor();
      // The history card never offers adding; files are added from the edit form only.
      assert.equal(await card.locator('input[type=file]').count(), 0, 'no file picker on the history card');
      assert.equal(await card.getByRole('button', { name: /^Choose files/ }).count(), 0);
      assert.doesNotMatch(await card.innerText(), /null/, 'no stray null text on the card');
      await card.getByRole('button', { name: /^Edit service visit/ }).click();
      await page.getByRole('button', { name: 'Choose files to attach to this service visit' }).waitFor();
      await page.locator('.svc-form input[type=file]').setInputFiles({ name: 'invoice.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
      await page.locator('.svc-form').getByText('invoice.pdf').waitFor();
      await page.locator('.svc-form input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
      await page.getByText('"notes.txt" is not a PDF, JPEG or PNG file.').waitFor();
      await page.getByRole('button', { name: 'Save changes' }).click();
      await card.getByText('invoice.pdf').waitFor();
      assert.deepEqual(await axe('service list with attachments'), []);
      await card.getByRole('button', { name: 'Preview receipt.png' }).click();
      const preview = page.getByRole('dialog', { name: 'Preview of receipt.png' });
      await preview.locator('img').waitFor();
      assert.deepEqual(await axe('attachment preview'), []);
      await preview.getByRole('button', { name: 'Close' }).click();
      await card.getByRole('button', { name: 'Rename invoice.pdf' }).click();
      await card.getByLabel('New name for invoice.pdf').fill('March invoice.pdf');
      await card.getByRole('button', { name: 'Save name' }).click();
      await card.getByText('March invoice.pdf').waitFor();
      await card.getByRole('button', { name: 'Remove receipt.png' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
      await card.getByRole('button', { name: 'Preview receipt.png' }).waitFor({ state: 'detached' });
      assert.deepEqual((await db.pool.query('SELECT file_name, content_type FROM service_attachments ORDER BY file_name')).rows, [{ file_name: 'March invoice.pdf', content_type: 'application/pdf' }]);

      // The visit lives in the API with exact strings: an item left empty stays unknown, a typed 0 stays zero.
      const stored = await db.pool.query("SELECT i.name, i.cost::text AS cost, v.visit_total_cost::text AS total, v.odometer_input::text AS odo FROM service_visits v JOIN service_items i ON i.visit_id = v.id ORDER BY i.position");
      assert.deepEqual(stored.rows, [{ name: 'Oil change', cost: '0', total: '89.50', odo: '45210' }, { name: 'Wipers', cost: null, total: '89.50', odo: '45210' }]);
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM fill_ups')).rows[0].n, 3, 'fuel records are untouched');

      // Search narrows the list.
      await page.getByLabel('Search').fill('nothing like this');
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.getByText('No service visits match these filters.').waitFor();
      await page.getByRole('link', { name: 'Clear' }).click();
      await card.waitFor();

      // Correct, then delete with confirmation.
      await card.getByRole('button', { name: /^Edit service visit/ }).click();
      await page.getByLabel('Provider (optional)').fill('Main Street Garage');
      await page.getByRole('button', { name: 'Save changes' }).click();
      await page.getByText('Main Street Garage').waitFor();
      await page.locator('article.svc-visit').first().getByRole('button', { name: /^Delete service visit/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('Start from today. Adding past service is optional.').waitFor();
      await noErrorPage();
    });

    await t.test('service history on a phone: reachable from the vehicle screen, add sheet, list, hidden by preference', async () => {
      const { ctx, p, phoneAxe, open } = await phonePage();
      try {
        await open(`${vehicle}/overview`);
        await p.getByRole('link', { name: /^Service/ }).click();
        await p.getByRole('heading', { name: 'Service', level: 1 }).waitFor();
        await p.getByText('Start from today. Adding past service is optional.').first().waitFor();
        assert.equal(await overflows(p), false, 'service overflows on a phone');
        assert.equal(await p.getByRole('navigation', { name: 'Main' }).getByRole('link').count(), 5, 'bottom navigation is unchanged');
        await p.getByRole('button', { name: 'Add service visit' }).click();
        const sheet = p.getByRole('dialog');
        await sheet.getByLabel('Item', { exact: true }).first().fill('Brake pads');
        await sheet.getByLabel(/^Cost \(.*optional\)$/).first().fill('120.00');
        await sheet.getByRole('button', { name: /^Take photo/ }).waitFor();
        await sheet.locator('input[type=file][capture]').setInputFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: TINY_PNG });
        await sheet.getByText('IMG_0001.png').waitFor();
        await sheet.locator('input[type=file]:not([capture])').setInputFiles({ name: 'garage.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
        await sheet.getByRole('list', { name: 'Files to attach' }).getByText('garage.pdf').waitFor();
        assert.deepEqual(await bothThemes(p, phoneAxe, 'service sheet'), []);
        await sheet.getByRole('button', { name: 'Add visit' }).click();
        await p.locator('article.svc-visit').first().waitFor();
        await p.locator('article.svc-visit').getByText('Brake pads').waitFor();
        await p.locator('article.svc-visit').getByText('IMG_0001.png').waitFor();
        await p.locator('article.svc-visit').getByText('garage.pdf').waitFor();
        assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM service_attachments WHERE file_name IN ('IMG_0001.png','garage.pdf')")).rows[0].n, 2);
        assert.equal(await overflows(p), false);
        assert.deepEqual(await bothThemes(p, phoneAxe, 'service list'), []);
        await p.emulateMedia({ colorScheme: 'light' });
        // More leads to it as well.
        await open('more');
        await p.getByRole('link', { name: /^Service/ }).waitFor();
        // Hiding the page for this vehicle removes the entries but not the data.
        const who = (await db.pool.query('SELECT id FROM users WHERE email = $1', [ADMIN.email])).rows[0].id;
        await db.pool.query('INSERT INTO vehicle_user_prefs (vehicle_id, user_id, show_service) VALUES ($1,$2,false)', [vehicle.split('/')[1], who]);
        await open(`${vehicle}/overview`);
        assert.equal(await p.getByRole('link', { name: /^Service/ }).count(), 0);
        await open('more');
        assert.equal(await p.getByRole('link', { name: /^Service/ }).count(), 0);
      } finally { await ctx.close(); }
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM service_visits')).rows[0].n, 1, 'data kept while hidden');
      // Restore: module off and nothing hidden, so the rest of the journey is as before.
      await db.pool.query("DELETE FROM vehicle_user_prefs");
      await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'");
      await page.goto(`${base}/#/${vehicle}`);
      await page.reload();
      await page.getByRole('heading', { name: 'At a glance' }).waitFor();
    });

    await t.test('maintenance planning on desktop: add a task, mark it done through a linked visit, snooze', async () => {
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      try {
        await page.goto(`${base}/#/${vehicle}/service?view=maintenance`);
        await page.reload();
        await page.getByRole('heading', { name: 'Service', level: 1 }).waitFor();
        await page.getByText('Add what you want to keep track of.').waitFor();
        await page.getByText("DriveLoom does not ship manufacturer schedules.").waitFor();
        assert.equal(await page.getByRole('navigation', { name: 'Service sections' }).getByRole('link', { name: 'Maintenance' }).getAttribute('aria-current'), 'page');
        assert.deepEqual(await axe('maintenance empty'), []);

        await page.getByRole('button', { name: 'Add maintenance task' }).click();
        await page.getByLabel('Common service types').selectOption({ label: 'Oil change' });
        assert.equal(await page.getByLabel('Task name').inputValue(), 'Oil change');
        await page.getByLabel('Every how many days (optional)').fill('365');
        await page.getByLabel('Interval distance').fill('15000');
        assert.deepEqual(await axe('maintenance form'), []);
        await page.getByRole('button', { name: 'Add task' }).click();
        const card = page.locator('article.mt-task').first();
        await card.getByRole('heading', { name: 'Oil change' }).waitFor();
        await card.getByText('No starting point', { exact: true }).waitFor();
        await card.getByText('Repeats every 365 days or 15,000 km, whichever comes first').waitFor();
        assert.deepEqual(await axe('maintenance list'), []);

        // "Mark done" opens the visit form with the item linked; nothing is linked automatically.
        await card.getByRole('button', { name: 'Mark done: Oil change' }).click();
        assert.equal(await page.getByLabel('Item', { exact: true }).first().inputValue(), 'Oil change');
        assert.equal(await page.getByLabel('Completes maintenance task (optional)').inputValue() !== '', true);
        await page.getByLabel('Odometer reading').fill('42000');
        await page.getByRole('button', { name: 'Add visit' }).click();
        await page.locator('article.mt-task').first().getByText('On track', { exact: true }).waitFor();
        await page.locator('article.mt-task').first().getByText(/Last done .* at 42,000 km/).waitFor();
        assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM service_items WHERE task_id IS NOT NULL')).rows[0].n, 1);

        // Snooze mutes reminders only; the status stays visible.
        await page.locator('article.mt-task').first().getByRole('button', { name: 'Snooze reminders for Oil change' }).click();
        await page.getByText('Snoozing only mutes reminders.').waitFor();
        assert.deepEqual(await axe('snooze form'), []);
        await page.getByLabel('Reason (optional)').fill('next week');
        await page.getByRole('button', { name: 'Snooze', exact: true }).click();
        await page.locator('article.mt-task').first().getByText(/Reminders muted for you until/).waitFor();
        await page.locator('article.mt-task').first().getByText('On track', { exact: true }).waitFor();
        assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM task_snoozes WHERE scope = 'personal'")).rows[0].n, 1);

        // The History section links the task by name and points at what needs attention.
        await page.getByRole('navigation', { name: 'Service sections' }).getByRole('link', { name: 'History' }).click();
        await page.locator('article.svc-visit').getByText('completes Oil change').waitFor();
        assert.deepEqual(await axe('service history with a linked item'), []);
        await noErrorPage();
      } finally {
        await db.pool.query('DELETE FROM service_visits');
        await db.pool.query('DELETE FROM maintenance_tasks');
        await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'");
      }
    });

    await t.test('maintenance planning on a phone: section in the Service screen, add and snooze in sheets, bottom navigation untouched', async () => {
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      const { ctx, p, phoneAxe, open } = await phonePage();
      try {
        await open(`${vehicle}/overview`);
        await p.getByRole('link', { name: /^Service/ }).click();
        await p.getByRole('heading', { name: 'Service', level: 1 }).waitFor();
        await p.getByRole('navigation', { name: 'Service sections' }).getByRole('link', { name: 'Maintenance' }).click();
        await p.getByText('Add what you want to keep track of.').waitFor();
        assert.equal(await p.getByRole('navigation', { name: 'Main' }).getByRole('link').count(), 5, 'bottom navigation is unchanged');
        assert.deepEqual(await bothThemes(p, phoneAxe, 'maintenance empty'), []);
        await p.getByRole('button', { name: 'Add maintenance task' }).click();
        const sheet = p.getByRole('dialog');
        await sheet.getByLabel('Task name').fill('Tyre rotation');
        await sheet.getByLabel('Interval distance').fill('10000');
        assert.deepEqual(await bothThemes(p, phoneAxe, 'maintenance sheet'), []);
        await sheet.getByRole('button', { name: 'Add task' }).click();
        const card = p.locator('article.mt-task').first();
        await card.getByRole('heading', { name: 'Tyre rotation' }).waitFor();
        assert.equal(await overflows(p), false, 'maintenance overflows on a phone');
        assert.deepEqual(await bothThemes(p, phoneAxe, 'maintenance list'), []);
        await card.getByRole('button', { name: 'Snooze reminders for Tyre rotation' }).click();
        const snooze = p.getByRole('dialog');
        await snooze.getByText('Snoozing only mutes reminders.').waitFor();
        assert.equal(await snooze.getByLabel('Additional distance', { exact: true }).isDisabled(), false, 'the vehicle has fuel records, so a distance snooze can be worked out');
        await snooze.getByText('Counted from the latest odometer reading, once, when you save.').waitFor();
        assert.deepEqual(await bothThemes(p, phoneAxe, 'snooze sheet'), []);
        await snooze.getByRole('radio', { name: '1 month' }).check();
        await snooze.getByRole('button', { name: 'Snooze', exact: true }).click();
        await p.locator('article.mt-task').first().getByText(/Reminders muted for you until/).waitFor();
        assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM task_snoozes WHERE scope = 'personal'")).rows[0].n, 1);
        await p.emulateMedia({ colorScheme: 'light' });
      } finally {
        await ctx.close();
        await db.pool.query('DELETE FROM maintenance_tasks');
        await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'");
      }
    });

    // ---------- community maintenance presets: banner and the five-step review-and-import flow ----------
    /** Runs `fn` with the journey's vehicle made a 2015 Honda Odyssey and the Service module on; everything is put back afterwards. */
    const asOdyssey = async (fn: () => Promise<void>) => {
      const vid = vehicle.split('/')[1];
      const before = (await db.pool.query('SELECT make, model, model_year FROM vehicles WHERE id = $1', [vid])).rows[0];
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      await db.pool.query("UPDATE vehicles SET make = 'Honda', model = 'Odyssey', model_year = 2015 WHERE id = $1", [vid]);
      try { await fn(); } finally {
        await db.pool.query('DELETE FROM maintenance_tasks');
        await db.pool.query('UPDATE vehicles SET make = $2, model = $3, model_year = $4 WHERE id = $1', [vid, before.make, before.model, before.model_year]);
        await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'");
      }
    };
    /** The whole flow on one page: banner, all five steps, then the imported tasks in the list. `check` runs accessibility checks at a few steps. */
    const presetJourney = async (p: Page, check: (label: string) => Promise<void>) => {
      await p.getByText('Maintenance recommendations available').waitFor();
      await check('banner');
      await p.getByRole('button', { name: 'Review maintenance recommendations' }).click();
      const dlg = p.getByRole('dialog', { name: 'Maintenance recommendations' });
      const step = (n: number, title: string) => dlg.getByText(`Step ${n} of 5`).waitFor().then(() => dlg.getByRole('heading', { name: title, level: 3 }).waitFor());
      // 1: the vehicle, the market confirmation and where the preset comes from.
      await step(1, 'Confirm your vehicle');
      await dlg.getByText('2015 Honda Odyssey', { exact: true }).waitFor();
      await dlg.getByText(/advisory/).waitFor();
      await dlg.getByText(/Reviewed on/).waitFor();
      await dlg.getByRole('button', { name: 'Next' }).click();
      await dlg.getByRole('alert').getByText('Confirm that this is a US-market vehicle to continue.').waitFor();
      await dlg.getByLabel('This vehicle is a US-market vehicle').check();
      await check('step 1');
      await dlg.getByRole('button', { name: 'Next' }).click();
      // 2: trust wording, an edited interval, a deselected task; there is no way to add a task.
      await step(2, 'Review the tasks');
      assert.equal(await dlg.getByText('Community suggestion — not an official manufacturer requirement').count(), 14, 'every community task carries its trust label');
      assert.equal(await dlg.getByText('Manufacturer information', { exact: true }).count(), 3, 'every manufacturer task carries its trust label');
      assert.equal(await dlg.getByRole('button', { name: /add/i }).count(), 0, 'the flow never adds tasks');
      await dlg.getByLabel('Engine oil and filter: every how many months (optional)').fill('12');
      await dlg.getByText('Every 12 months or 5,000 mi, whichever comes first').waitFor();
      await dlg.getByText(/You changed this interval/).waitFor();
      for (const name of ['Transmission fluid', 'Tire rotation', 'Brake inspection', 'Engine air filter', 'Dust and pollen (cabin) filter', 'Drive belt inspection', 'Engine coolant', 'Spark plugs', 'Water pump inspection', 'Valve clearance inspection', 'Idle speed inspection', 'Battery terminal check', 'Wiper blades', 'General inspection']) await dlg.getByLabel(`Include ${name}`, { exact: true }).uncheck();
      await check('step 2');
      await dlg.getByRole('button', { name: 'Next' }).click();
      // 3: a starting point per selected task. Only these three are listed.
      await step(3, 'When was each one last done?');
      assert.equal(await dlg.getByRole('group').count(), 3);
      await dlg.getByText(/Latest odometer on record|No odometer reading is on record yet/).waitFor();
      await dlg.getByRole('group', { name: 'Brake fluid' }).getByRole('radio', { name: 'I know when it was last done' }).check();
      await dlg.getByLabel('Date Brake fluid was last done (optional)').fill('2024-05-10');
      await dlg.getByRole('group', { name: 'Engine oil and filter' }).getByRole('radio', { name: 'Start tracking now' }).check();
      await dlg.getByText(/This is not proof that the work was done/).waitFor();
      assert.equal(await dlg.getByRole('group', { name: 'Timing belt' }).getByRole('radio', { name: "I don't know" }).isChecked(), true, 'I don\'t know is the default');
      await check('step 3');
      await dlg.getByRole('button', { name: 'Next' }).click();
      // 4: the server's preview. Missing and tracking starting points are never shown as up to date.
      await step(4, 'Preview');
      const results = dlg.getByRole('list', { name: 'Preview of the import' });
      await results.waitFor();
      const item = (name: string) => results.getByRole('listitem').filter({ has: p.getByText(name, { exact: true }) });
      await item('Brake fluid').getByText(/Next due .*2027/).waitFor();
      await item('Engine oil and filter').getByText(/not a completed service/).waitFor();
      await item('Timing belt').getByText(/Baseline needed/).waitFor();
      assert.doesNotMatch(await results.innerText(), /On track|(?<!shown as |overdue or )up to date/i);
      assert.equal(await dlg.getByRole('radio', { name: /Skip|Link/ }).count(), 0, 'no similar task, so no duplicate choice');
      await check('step 4');
      await dlg.getByRole('button', { name: 'Next' }).click();
      // 5: reminders stay off and are not offered here; Import writes.
      await step(5, 'Reminders and import');
      await dlg.getByText('Imported tasks start with email reminders off; you can turn them on per task later.').waitFor();
      assert.equal(await dlg.getByRole('checkbox', { name: /remind/i }).count() + await dlg.getByRole('switch').count(), 0, 'reminders are not offered in the flow');
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM maintenance_tasks')).rows[0].n, 0, 'nothing is saved before Import');
      await check('step 5');
      await dlg.getByRole('button', { name: 'Import' }).click();
      await dlg.getByRole('heading', { name: 'Import finished' }).waitFor();
      await dlg.getByText('Added: 3').waitFor();
      await dlg.getByRole('button', { name: 'Back to the Maintenance list' }).click();
      await dlg.waitFor({ state: 'detached' });
      // The list refreshed: three tasks, reminders off, baselines as chosen.
      const cards = p.locator('article.mt-task');
      await cards.nth(2).waitFor();
      assert.equal(await cards.count(), 3);
      const card = (name: string) => p.getByRole('article', { name: `Maintenance task ${name}` });
      await card('Timing belt').getByText('No starting point', { exact: true }).waitFor();
      await card('Timing belt').getByText('Email reminders are off for this task.').waitFor();
      await card('Engine oil and filter').getByText('Tracking only', { exact: true }).waitFor();
      assert.equal(await card('Engine oil and filter').getByText('No starting point').count(), 0, 'a tracking point is not "No starting point"');
      await card('Engine oil and filter').getByText(/Tracking since .* not a completed service/).first().waitFor();
      await card('Engine oil and filter').getByText('Originally suggested by the preset. The interval is now your own.').waitFor();
      await card('Brake fluid').getByText(/^Originally suggested by the preset \(manufacturer information\)/).waitFor();
      await card('Brake fluid').getByText(/Last done .*2024.*as you reported/).waitFor();
      const rows = (await db.pool.query('SELECT name, reminders_enabled, baseline_kind, source_trust, interval_months FROM maintenance_tasks ORDER BY name')).rows;
      assert.deepEqual(rows, [
        { name: 'Brake fluid', reminders_enabled: false, baseline_kind: 'reported', source_trust: 'manufacturer', interval_months: 36 },
        { name: 'Engine oil and filter', reminders_enabled: false, baseline_kind: 'tracking', source_trust: null, interval_months: 12 },
        { name: 'Timing belt', reminders_enabled: false, baseline_kind: null, source_trust: 'community', interval_months: 84 },
      ]);
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM service_visits')).rows[0].n, 0, 'no service record is invented');
      // Fourteen tasks are still on offer, so the banner stays; the three imported ones are not offered again.
      await p.getByText('Maintenance recommendations available').waitFor();
      await p.getByRole('button', { name: 'Review maintenance recommendations' }).click();
      await dlg.getByLabel('This vehicle is a US-market vehicle').check();
      await dlg.getByRole('button', { name: 'Next' }).click();
      await step(2, 'Review the tasks');
      assert.equal(await dlg.getByText(/Already imported/).count(), 3);
      await p.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
    };

    await t.test('maintenance recommendations on desktop: no banner without a match, then the five-step review and import', async () => {
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      try {
        // No preset for this vehicle: the tab looks exactly as before.
        await page.goto(`${base}/#/${vehicle}/service?view=maintenance`);
        await page.reload();
        await page.getByText('Add what you want to keep track of.').waitFor();
        assert.equal(await page.getByText('Maintenance recommendations available').count(), 0);
      } finally { await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'"); }
      await asOdyssey(async () => {
        await page.goto(`${base}/#/${vehicle}/service?view=maintenance`);
        await page.reload();
        await presetJourney(page, async (label) => assert.deepEqual(await axe(`presets ${label}`), []));
        await noErrorPage();
      });
    });

    await t.test('maintenance recommendations on a phone: the same flow in a sheet, and a vehicle without a match shows nothing', async () => {
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      try {
        const { ctx, p } = await phonePage();
        try {
          await p.goto('about:blank');
          await p.goto(`${base}/#/${vehicle}/service?view=maintenance`);
          await p.getByText('Add what you want to keep track of.').waitFor();
          assert.equal(await p.getByText('Maintenance recommendations available').count(), 0);
        } finally { await ctx.close(); }
      } finally { await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'"); }
      await asOdyssey(async () => {
        const { ctx, p, phoneAxe, open } = await phonePage();
        try {
          await open(`${vehicle}/service?view=maintenance`);
          let n = 0;
          // Both themes are slow; the opening step and the preview stand for the rest.
          await presetJourney(p, async (label) => {
            if (label === 'banner' || label === 'step 4') assert.deepEqual(await bothThemes(p, phoneAxe, `presets ${label}`), []);
            n++;
            assert.equal(await overflows(p), false, `presets ${label} overflows on a phone`);
          });
          assert.ok(n >= 6);
          await p.emulateMedia({ colorScheme: 'light' });
        } finally { await ctx.close(); }
      });
    });

    await t.test('reminders by email on desktop: no-SMTP notice, owner settings and the personal switch', async () => {
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      const vid = vehicle.split('/')[1];
      try {
        await page.goto(`${base}/#/${vehicle}/service?view=maintenance`);
        await page.reload();
        const panel = page.getByRole('region', { name: 'Reminders by email' });
        const notice = 'Ask your administrator to configure email; in-app reminders keep working.';
        // An earlier step saved SMTP settings: no notice. Without SMTP the notice shows (and stays for the phone step).
        await panel.getByText('Reminder emails are off for this vehicle.').waitFor();
        assert.ok(integrations.mailer, 'SMTP configured by the administration step');
        assert.equal(await panel.getByText(notice).count(), 0);
        await integrations.clearSmtp();
        await page.reload();
        await panel.getByText(notice).waitFor();
        assert.equal(await panel.getByRole('switch', { name: 'Email me about this vehicle' }).isChecked(), true);
        assert.deepEqual(await axe('reminders by email'), []);
        await panel.getByRole('button', { name: 'Change email settings' }).click();
        await page.getByRole('heading', { name: 'Reminder email settings' }).waitFor();
        const owner = page.getByRole('group', { name: 'Who gets the emails' }).getByRole('checkbox').first();
        assert.equal(await owner.isChecked(), true); assert.equal(await owner.isDisabled(), true, 'the owner is always included');
        assert.deepEqual(await axe('reminder email settings'), []);
        await page.getByRole('switch', { name: 'Send reminder emails for this vehicle' }).check();
        await page.getByLabel('Repeat while a task stays due').selectOption({ label: 'Every 2 weeks' });
        await page.getByRole('button', { name: 'Save email settings' }).click();
        await page.getByText('Reminder emails are on for this vehicle. While a task stays due, the reminder is repeated every 14 days.').waitFor();
        assert.deepEqual((await db.pool.query('SELECT email_enabled, follow_up_days FROM vehicle_notification_settings WHERE vehicle_id = $1', [vid])).rows, [{ email_enabled: true, follow_up_days: 14 }]);
        await page.getByRole('switch', { name: 'Email me about this vehicle' }).uncheck();
        await page.getByText('You have turned off reminder emails for this vehicle.').waitFor();
        assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM vehicle_notification_optouts WHERE vehicle_id = $1', [vid])).rows[0].n, 1);
        assert.deepEqual(await axe('reminders by email, opted out'), []);
        await noErrorPage();
      } finally {
        await db.pool.query('DELETE FROM vehicle_notification_optouts');
        await db.pool.query('DELETE FROM vehicle_notification_settings');
        await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'");
      }
    });

    await t.test('reminders by email on a phone: personal switch inline, settings in a sheet, bottom navigation untouched', async () => {
      await db.pool.query("INSERT INTO instance_modules (module, enabled) VALUES ('service', true) ON CONFLICT (module) DO UPDATE SET enabled = true");
      const vid = vehicle.split('/')[1];
      const { ctx, p, phoneAxe, open } = await phonePage();
      try {
        await open(`${vehicle}/service?view=maintenance`);
        const panel = p.getByRole('region', { name: 'Reminders by email' });
        await panel.waitFor();
        await panel.getByText('Ask your administrator to configure email; in-app reminders keep working.').waitFor();
        assert.equal(await p.getByRole('navigation', { name: 'Main' }).getByRole('link').count(), 5, 'bottom navigation is unchanged');
        assert.equal(await overflows(p), false, 'reminders panel overflows on a phone');
        assert.deepEqual(await bothThemes(p, phoneAxe, 'reminders by email'), []);
        await panel.getByRole('button', { name: 'Change email settings' }).click();
        const sheet = p.getByRole('dialog');
        await sheet.getByRole('switch', { name: 'Send reminder emails for this vehicle' }).waitFor();
        assert.deepEqual(await bothThemes(p, phoneAxe, 'reminder email settings sheet'), []);
        await sheet.getByRole('switch', { name: 'Send reminder emails for this vehicle' }).check();
        await sheet.getByRole('button', { name: 'Save email settings' }).click();
        await p.getByText(/Reminder emails are on for this vehicle\./).waitFor();
        assert.equal((await db.pool.query('SELECT email_enabled FROM vehicle_notification_settings WHERE vehicle_id = $1', [vid])).rows[0].email_enabled, true);
        await p.getByRole('switch', { name: 'Email me about this vehicle' }).uncheck();
        await p.getByText('You have turned off reminder emails for this vehicle.').waitFor();
        assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM vehicle_notification_optouts WHERE vehicle_id = $1', [vid])).rows[0].n, 1);
        await p.emulateMedia({ colorScheme: 'light' });
      } finally {
        await ctx.close();
        await db.pool.query('DELETE FROM vehicle_notification_optouts');
        await db.pool.query('DELETE FROM vehicle_notification_settings');
        await db.pool.query("UPDATE instance_modules SET enabled = false WHERE module = 'service'");
      }
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

    await t.test('the service worker caches the shell, never an API response, and sign-out keeps the shell but drops other caches', async () => {
      // localhost is a secure context, so the worker registers.
      await page.goto(`${base}/#/`);
      // The page runs in a browser; the test's TypeScript has no DOM types, so the snippets are strings.
      // Start from a fresh install.
      await page.evaluate('navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then(() => caches.keys()).then((ks) => Promise.all(ks.map((k) => caches.delete(k))))');
      await page.reload();
      await page.evaluate('navigator.serviceWorker.ready.then(() => undefined)');
      await page.waitForFunction("caches.keys().then((k) => Promise.all(k.map((n) => caches.open(n).then((c) => c.match('/js/pwa.js'))))).then((r) => r.some(Boolean))");
      // Authenticated API traffic, reads and a write, in both the page and the worker's reach.
      await page.evaluate("Promise.all(['/v1/auth/session', '/v1/vehicles', '/v1/preferences', '/v1/friends'].map((u) => fetch(u).then((r) => r.text())))");
      const cached = await cachedPaths(page);
      assert.ok(cached.includes('/') && cached.includes('/styles.css') && cached.includes('/js/pwa.js'), cached.join(' '));
      assert.deepEqual(cached.filter((p) => p.includes('/v1')), [], 'no API request is cached');
      // Something that is not the shell, which sign-out must drop.
      await page.evaluate("caches.open('scratch-data').then((c) => c.put('/scratch', new Response('x')))");
      await page.getByRole('button', { name: /sign out/i }).click();
      await page.getByRole('heading', { name: 'Sign in' }).waitFor();
      await page.waitForFunction("caches.keys().then((k) => !k.includes('scratch-data'))");
      const keys = await page.evaluate('caches.keys()') as string[];
      assert.ok(keys.length > 0 && keys.every((k) => k.startsWith('driveloom-shell-')), `only shell caches remain: ${keys.join(' ')}`);
      const after = await cachedPaths(page);
      assert.ok(after.includes('/') && after.includes('/js/main.js') && after.includes('/js/pwa.js'), 'the shell survives sign-out, so an offline cold start still works');
      assert.deepEqual(after.filter((p) => p.includes('/v1')), [], 'still no API request cached');
    });

    assert.deepEqual(problems, [], 'no console errors, page errors or CSP violations');
  } finally {
    await browser.close();
    server.close(); server.closeAllConnections();
    await db.drop();
  }
});
