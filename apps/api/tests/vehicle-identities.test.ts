// Make/model aliases and the optional suggestions endpoint: spellings of the same
// name match bundled presets, free text is compared by plain normalisation and is
// never rewritten, and trim or variant words are never dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { MaintenanceService } from '../src/service/maintenance.ts';
import { maintenanceRoutes } from '../src/service/maintenance-routes.ts';
import { setModule } from '../src/modules.ts';
import { bundledPresets, matchPresets } from '../src/service/presets.ts';
import { canonicalMake, canonicalModel, sameMake, sameModel, suggestIdentities } from '../src/vehicles/model-identity.ts';
import { MAKES, MODELS } from '../src/vehicles/identity-table.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const ODY = 'us-honda-odyssey-2015';

// ---------- pure ----------
test('make aliases resolve to one canonical id; unknown makes keep plain normalisation', () => {
  for (const s of ['Honda', 'honda', ' HONDA ', 'Honda.']) assert.equal(canonicalMake(s), 'honda');
  assert.equal(canonicalMake('Chevy'), 'chevrolet');
  assert.equal(canonicalMake('VW'), 'volkswagen');
  for (const s of ['Mercedes', 'mercedes benz', 'Mercedes-Benz']) assert.equal(canonicalMake(s), 'mercedes-benz');
  assert.equal(canonicalMake('Acme Motors'), 'acme-motors', 'unknown text is only normalised');
  assert.equal(canonicalMake(''), '');
  assert.equal(canonicalMake(null), '');
  assert.ok(sameMake('chevy', 'Chevrolet'));
  assert.ok(!sameMake('', ''));
  assert.ok(!sameMake('Chevrolet', 'Honda'));
});

test('model aliases are per make and trim or variant words are never dropped', () => {
  assert.equal(canonicalModel('CRV', 'honda'), 'cr-v');
  assert.equal(canonicalModel('CR V', 'Honda'), 'cr-v');
  assert.equal(canonicalModel('crv', 'toyota'), 'crv', "another make's alias does not apply");
  assert.equal(canonicalModel('Odyssey EX-L', 'honda'), 'odyssey-ex-l');
  assert.ok(!sameModel('honda', 'Odyssey EX-L', 'odyssey'));
  assert.ok(!sameModel('honda', 'Odyssey Touring', 'odyssey'));
  assert.ok(sameModel('honda', 'ODYSSEY', 'odyssey'));
  assert.ok(sameModel('honda', 'cr-v', 'CRV'));
  assert.ok(!sameModel('honda', '', ''));
});

test('the table is small, lowercase-slugged and has no alias that is a trim word, and every spelling resolves to its entry', () => {
  assert.ok(MAKES.length >= 25 && MAKES.length <= 60);
  for (const m of MAKES) for (const k of [m.id, m.name, ...(m.aliases ?? [])]) assert.equal(canonicalMake(k), m.id, `${k} resolves to ${m.id}`);
  for (const m of MODELS) {
    assert.ok(MAKES.some((x) => x.id === m.make), `${m.id} has a known make`);
    for (const k of [m.id, m.name, ...(m.aliases ?? [])]) assert.equal(canonicalModel(k, m.make), m.id);
  }
  const trims = /\b(ex|lx|se|le|xle|touring|sport|limited|ex-l|sel|premium)\b/i;
  for (const m of MODELS) for (const k of m.aliases ?? []) assert.ok(!trims.test(k), `${k} is a trim word`);
});

test('matching uses aliases and still compares unknown text plainly', () => {
  const ps = bundledPresets();
  const m = (make: string | null, model: string | null, year: number | null = 2015) => matchPresets(ps, { make, model, year }, 'us').map((p) => p.id);
  assert.deepEqual(m('Honda ', 'ODYSSEY'), [ODY]);
  assert.deepEqual(m('honda', 'odyssey'), [ODY]);
  assert.deepEqual(m('Honda', 'Odyssey EX-L'), [], 'variant words are not dropped');
  assert.deepEqual(m('Hondaa', 'Odyssey'), []);
  assert.deepEqual(m('Zorblax', 'Custom One'), []);
});

test('suggestions: filtered by prefix and alias, models only for one known make, loaded presets included', () => {
  const none = suggestIdentities('', '', []);
  assert.equal(none.makes.length, MAKES.length);
  assert.deepEqual(none.models, []);
  assert.deepEqual(suggestIdentities('ch', '', []).makes.map((s) => s.name), ['Chevrolet', 'Chrysler']);
  assert.deepEqual(suggestIdentities('vw', '', []).makes, [{ id: 'volkswagen', name: 'Volkswagen' }]);
  assert.ok(suggestIdentities('Honda', '', []).models.some((s) => s.name === 'CR-V'));
  assert.deepEqual(suggestIdentities('honda', 'od', []).models, [{ id: 'odyssey', name: 'Odyssey' }]);
  assert.deepEqual(suggestIdentities('nothing-known', '', []).models, []);
  const extra = suggestIdentities('ac', '', [{ make: 'acme-cars', model: 'road-runner' }]);
  assert.deepEqual(extra.makes.map((s) => s.name), ['Acme Cars', 'Acura']);
  assert.deepEqual(suggestIdentities('acme cars', '', [{ make: 'acme-cars', model: 'road-runner' }]).models, [{ id: 'road-runner', name: 'Road Runner' }]);
  assert.equal(suggestIdentities('honda', '', bundledPresets()).models.filter((s) => s.id === 'odyssey').length, 1, 'no duplicate for a table model that has a preset');
});

// ---------- database ----------
let db: TestDb | null, app: TestApp, owner: TestUser;
before(async () => {
  db = await createTestDb();
  if (!db) return;
  owner = await createTestUser(db.pool);
  const vehicles = new VehicleService(db.pool);
  app = await startApp([owner], [...vehicleRoutes(vehicles), ...maintenanceRoutes(new MaintenanceService(db.pool, vehicles))]);
  await setModule(db.pool, 'service', true);
});
after(async () => { app?.close(); await db?.drop(); });

test('GET /v1/vehicle-identities needs sign-in and returns {makes, models}', { skip }, async () => {
  assert.equal((await app.call(null, 'GET', '/v1/vehicle-identities')).status, 401);
  const all = await app.call(owner, 'GET', '/v1/vehicle-identities');
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(Object.keys(all.json).sort(), ['makes', 'models']);
  assert.ok(all.json.makes.every((s: Record<string, unknown>) => typeof s['id'] === 'string' && typeof s['name'] === 'string' && Object.keys(s).length === 2));
  assert.deepEqual(all.json.models, []);
  const chevy = await app.call(owner, 'GET', '/v1/vehicle-identities?make=chev');
  assert.deepEqual(chevy.json.makes, [{ id: 'chevrolet', name: 'Chevrolet' }]);
  const honda = await app.call(owner, 'GET', '/v1/vehicle-identities?make=Honda&model=ody');
  assert.deepEqual(honda.json.models, [{ id: 'odyssey', name: 'Odyssey' }]);
  const unknown = await app.call(owner, 'GET', `/v1/vehicle-identities?make=${encodeURIComponent('Zorblax')}`);
  assert.deepEqual(unknown.json, { makes: [], models: [] });
  assert.equal((await app.call(owner, 'GET', `/v1/vehicle-identities?make=${'x'.repeat(81)}`)).status, 422);
});

test('legacy and alias free text still matches the preset; custom text saves verbatim and never matches; rows are not rewritten', { skip }, async () => {
  const mk = async (make: string, model: string) => {
    const r = await app.call(owner, 'POST', '/v1/vehicles', { name: null, make, model, year: 2015, odometerUnit: 'mi', currency: 'USD' });
    assert.equal(r.status, 201, r.text);
    return r.json;
  };
  const ids = async (v: { id: string }) => ((await app.call(owner, 'GET', `/v1/vehicles/${v.id}/maintenance/presets`)).json.items as { id: string }[]).map((p) => p.id);
  const before = new Map<string, unknown>();
  const legacy = await mk('Honda ', 'ODYSSEY');
  const custom = await mk('Zorblax', 'Custom One');
  const trim = await mk('Honda', 'Odyssey EX-L');
  for (const v of [legacy, custom, trim]) before.set(v.id, (await db!.pool.query('SELECT * FROM vehicles WHERE id = $1', [v.id])).rows[0]);
  assert.equal(legacy.make, 'Honda', 'saved as typed (the API trims only the ends)');
  assert.equal(legacy.model, 'ODYSSEY');
  assert.deepEqual([custom.make, custom.model], ['Zorblax', 'Custom One']);
  assert.deepEqual(await ids(legacy), [ODY]);
  assert.deepEqual(await ids(custom), []);
  assert.deepEqual(await ids(trim), [], 'a variant word is not silently dropped');
  // Reading suggestions and matching rewrote nothing.
  await app.call(owner, 'GET', '/v1/vehicle-identities?make=honda');
  for (const [id, row] of before) assert.deepEqual((await db!.pool.query('SELECT * FROM vehicles WHERE id = $1', [id])).rows[0], row);
});
