import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { FriendService } from '../src/friends/service.ts';
import { friendRoutes } from '../src/friends/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp;
let ana: TestUser, ben: TestUser, cy: TestUser, admin: TestUser;
const NOW = new Date('2026-06-30T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [ana, ben, cy, admin] = await Promise.all([
    createTestUser(db.pool, { email: 'ana@example.test' }), createTestUser(db.pool, { email: 'ben@example.test' }),
    createTestUser(db.pool, { email: 'cy@example.test' }), createTestUser(db.pool, { role: 'admin' }),
  ]) as [TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles, () => NOW);
  app = await startApp([ana, ben, cy, admin], [...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...preferenceRoutes(db.pool), ...friendRoutes(new FriendService(db.pool, vehicles, fuel, () => NOW))]);
});
after(async () => { app?.close(); await db?.drop(); });

async function car(owner: TestUser, name: string, fills: [number, string, string, Record<string, unknown>?][], over: Record<string, unknown> = {}): Promise<string> {
  const v = (await app.call(owner, 'POST', '/v1/vehicles', { name, currency: 'EUR', ...over })).json.id as string;
  for (const [daysAgo, odometer, volume, extra] of fills) {
    const r = await app.call(owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: ago(daysAgo), odometer: { value: odometer, unit: 'km' }, volume: { value: volume, unit: 'l' }, ...extra });
    assert.equal(r.status, 201, r.text);
  }
  return v;
}
const befriend = async (a: TestUser, b: TestUser) => {
  assert.deepEqual((await app.call(a, 'POST', '/v1/friends', { email: b.email })).json, { status: 'pending' });
  const incoming = (await app.call(b, 'GET', '/v1/friends')).json.incoming;
  assert.equal((await app.call(b, 'PUT', `/v1/friends/${incoming[0].id}`)).status, 204);
  return incoming[0].id as string;
};
const compare = async (as: TestUser, window = '90d') => (await app.call(as, 'GET', `/v1/comparisons?window=${window}`)).json;

test('friend requests: mutual, only the addressee accepts, either side removes', { skip }, async () => {
  assert.equal((await app.call(ana, 'POST', '/v1/friends', { email: 'nobody@example.test' })).status, 422);
  assert.equal((await app.call(ana, 'POST', '/v1/friends', { email: ana.email })).status, 422);
  assert.deepEqual((await app.call(ana, 'POST', '/v1/friends', { email: ' CY@example.test ' })).json, { status: 'pending' });
  assert.deepEqual((await app.call(ana, 'POST', '/v1/friends', { email: cy.email })).json, { status: 'pending' }, 'asking twice changes nothing');
  const out = (await app.call(ana, 'GET', '/v1/friends')).json;
  assert.deepEqual([out.friends.length, out.incoming.length, out.outgoing.length], [0, 0, 1]);
  const id = out.outgoing[0].id;
  assert.equal((await app.call(ana, 'PUT', `/v1/friends/${id}`)).status, 404, 'the requester cannot accept their own request');
  assert.equal((await app.call(ben, 'PUT', `/v1/friends/${id}`)).status, 404, 'a third party cannot accept');
  assert.equal((await app.call(ben, 'DELETE', `/v1/friends/${id}`)).status, 404);
  assert.equal((await compare(cy)).friends.length, 0, 'pending grants nothing');
  // Asking back is acceptance.
  assert.deepEqual((await app.call(cy, 'POST', '/v1/friends', { email: ana.email })).json, { status: 'accepted' });
  assert.equal((await app.call(cy, 'GET', '/v1/friends')).json.friends[0].userId, ana.id);
  assert.equal((await app.call(cy, 'DELETE', `/v1/friends/${id}`)).status, 204);
  assert.equal((await app.call(ana, 'GET', '/v1/friends')).json.friends.length, 0);
  assert.equal((await app.call(null, 'GET', '/v1/friends')).status, 401);
});

test('comparison needs friendship AND owner opt-in; revocation is immediate; only aggregates cross', { skip }, async () => {
  const shared = await car(ben, 'Ben Shared', [[40, '1000', '40'], [31, '1500', '30'], [20, '2000', '35'], [10, '2500', '32.5', { notes: 'secret note' }]], { make: 'Skoda', model: 'Octavia', year: 2019 });
  const hidden = await car(ben, 'Ben Private', [[40, '100', '40'], [20, '600', '50']]);
  await car(ana, 'Ana Car', [[50, '0', '30'], [25, '800', '40']]);

  await app.call(ben, 'PUT', `/v1/vehicles/${shared}/comparison`, { enabled: true });
  assert.equal((await compare(ana)).friends.length, 0, 'opt-in without friendship exposes nothing');
  const friendship = await befriend(ana, ben);

  const c = await compare(ana);
  assert.equal(c.window.key, '90d');
  assert.equal(c.mine.length, 1);
  assert.deepEqual(c.mine[0].economy, { value: '5.00', unit: 'l_per_100km' });
  assert.deepEqual(c.friends, [{
    userId: ben.id, displayName: '',
    vehicles: [{ name: 'Ben Shared', make: 'Skoda', model: 'Octavia', year: 2019, economy: { value: '6.5', unit: 'l_per_100km' }, costPerDistance: null, costUnavailableReason: 'currency_mismatch' }],
  }], 'exactly these fields: no ids, dates, distances, volumes, counts or notes');
  assert.ok(!JSON.stringify(c.friends).includes(shared) && !JSON.stringify(c).includes('secret note') && !JSON.stringify(c).includes('Ben Private'));

  // Friendship is not membership: every vehicle route still answers 404.
  for (const path of ['', '/fill-ups', '/stats', '/members', '/comparison']) {
    assert.equal((await app.call(ana, 'GET', `/v1/vehicles/${shared}${path}`)).status, 404, path);
    assert.equal((await app.call(ana, 'GET', `/v1/vehicles/${hidden}${path}`)).status, 404, path);
  }
  assert.equal((await app.call(ana, 'PUT', `/v1/vehicles/${shared}/comparison`, { enabled: false })).status, 404);
  assert.equal((await compare(cy)).friends.length, 0, 'a third user sees nothing');
  assert.equal((await compare(admin)).friends.length, 0, 'admins get no comparison access');

  // Same window for both sides; a narrower window changes the aggregate.
  assert.equal((await compare(ana, '30d')).friends[0].vehicles[0].economy.value, '6.8'); // 67.5 L over 1000 km
  assert.equal((await app.call(ana, 'GET', '/v1/comparisons?window=7d')).status, 422);

  // Opt-out revokes on the next request; opting back in restores.
  await app.call(ben, 'PUT', `/v1/vehicles/${shared}/comparison`, { enabled: false });
  assert.equal((await compare(ana)).friends.length, 0);
  await app.call(ben, 'PUT', `/v1/vehicles/${shared}/comparison`, { enabled: true });
  assert.equal((await compare(ana)).friends.length, 1);
  // Unfriending revokes both directions.
  assert.equal((await app.call(ana, 'DELETE', `/v1/friends/${friendship}`)).status, 204);
  assert.equal((await compare(ana)).friends.length, 0);
  assert.equal((await compare(ben)).friends.length, 0);
  const audit = await db!.pool.query("SELECT action FROM audit_events WHERE subject_id = $1 AND action LIKE 'comparison.%' ORDER BY id", [shared]);
  assert.deepEqual(audit.rows.map((r) => r.action), ['comparison.opt_in', 'comparison.opt_out', 'comparison.opt_in']);
});

test('only the owner opts a vehicle in; editors of a shared vehicle cannot expose it', { skip }, async () => {
  const v = await car(cy, 'Cy Car', [[30, '0', '30'], [10, '500', '30']]);
  await app.call(cy, 'POST', `/v1/vehicles/${v}/members`, { userId: ben.id, role: 'editor' });
  const r = await app.call(ben, 'PUT', `/v1/vehicles/${v}/comparison`, { enabled: true });
  assert.deepEqual([r.status, r.json.code], [403, 'forbidden']);
  assert.deepEqual((await app.call(ben, 'GET', `/v1/vehicles/${v}/comparison`)).json, { enabled: false });
  assert.equal((await app.call(cy, 'PUT', `/v1/vehicles/${v}/comparison`, { enabled: 'yes' })).status, 422);
  // Ben is a friend of Ana (again) and an editor of Cy's car: Ana must not see Cy's car through Ben.
  await befriend(ben, ana);
  await app.call(cy, 'PUT', `/v1/vehicles/${v}/comparison`, { enabled: true });
  assert.ok(!JSON.stringify(await compare(ana)).includes('Cy Car'));
});

test('viewer units and currency guard', { skip }, async () => {
  const dana = await createTestUser(db!.pool), eli = await createTestUser(db!.pool);
  const local = await startApp([dana, eli], [...vehicleRoutes(new VehicleService(db!.pool)), ...fuelRoutes(new FuelService(db!.pool, new VehicleService(db!.pool), () => NOW)), ...preferenceRoutes(db!.pool),
    ...friendRoutes(new FriendService(db!.pool, new VehicleService(db!.pool), new FuelService(db!.pool, new VehicleService(db!.pool), () => NOW), () => NOW))]);
  try {
    const post = (as: TestUser, path: string, b: unknown, m = 'POST') => local.call(as, m, path, b);
    const mk = async (currency: string) => {
      const v = (await post(eli, '/v1/vehicles', { name: `Eli ${currency}`, currency })).json.id;
      for (const [d, o, vol, amount] of [[30, '0', '30', '50'], [10, '500', '35', '70']] as const) {
        await post(eli, `/v1/vehicles/${v}/fill-ups`, { occurredAt: ago(d), odometer: { value: o, unit: 'km' }, volume: { value: vol, unit: 'l' }, cost: { amount, currency } });
      }
      await post(eli, `/v1/vehicles/${v}/comparison`, { enabled: true }, 'PUT');
    };
    await mk('EUR'); await mk('GBP');
    await post(dana, '/v1/friends', { email: eli.email });
    await post(eli, '/v1/friends', { email: dana.email });
    await post(dana, '/v1/preferences', { economyUnit: 'mpg_imp', currency: 'EUR' }, 'PUT');
    const c = (await local.call(dana, 'GET', '/v1/comparisons?window=all')).json;
    assert.deepEqual(c.units, { economy: 'mpg_imp', distance: 'mi', currency: 'EUR' });
    const [eur, gbp] = c.friends[0].vehicles;
    assert.deepEqual(eur.economy, { value: '40.4', unit: 'mpg_imp' }); // 7 L/100 km
    assert.deepEqual(eur.costPerDistance, { value: '0.2253', currency: 'EUR', per: 'mi' }); // 70 EUR over 310.686 mi
    assert.equal(eur.costUnavailableReason, null);
    assert.deepEqual([gbp.costPerDistance, gbp.costUnavailableReason], [null, 'currency_mismatch'], 'costs in another currency are not compared');
    assert.equal(gbp.economy.value, '40.4', 'efficiency still compares');
  } finally { local.close(); }
});

test('a disabled friend disappears from lists and comparisons', { skip }, async () => {
  const f = await createTestUser(db!.pool), g = await createTestUser(db!.pool);
  const vehicles = new VehicleService(db!.pool), fuel = new FuelService(db!.pool, vehicles, () => NOW), svc = new FriendService(db!.pool, vehicles, fuel, () => NOW);
  await svc.request(f.principal, { email: g.email });
  await svc.request(g.principal, { email: f.email });
  const v = await vehicles.create(g.principal, { name: 'G' });
  await svc.setOptIn(g.principal, v.id, { enabled: true });
  assert.equal((await svc.compare(f.principal, 'all')).friends.length, 1);
  await db!.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [g.id]);
  assert.equal((await svc.compare(f.principal, 'all')).friends.length, 0);
  assert.equal((await svc.list(f.principal)).friends.length, 0);
});
