// The phone's live economy preview (apps/web/js/economy.js) must show exactly
// what the server reports once the fill-up is saved. Part one compares the
// web module's arithmetic with the server's pure modules; part two saves real
// fill-ups through the HTTP layer and compares each response with the
// preview computed beforehand from the list the client would have loaded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Dec } from '../src/decimal.ts';
import { DISPLAY_SCALE, economy, fromKm, fromLitres, KM_PER, L_PER, toKm, toLitres, type EconomyUnit } from '../src/units.ts';
import { intervals, type Fill } from '../src/fuel/economy.ts';
import { decimal } from '../src/http/validate.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import type { DistanceUnit, Id, VolumeUnit } from '../src/types.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';

// The web client is plain ESM with no type declarations; describe what the test uses.
interface WebDec { toFixed(scale: number): string; toDecimal(scale: number): string; cmp(o: WebDec): number; add(o: WebDec): WebDec; sub(o: WebDec): WebDec; mul(o: WebDec): WebDec; div(o: WebDec): WebDec }
interface Quantity { value: string; unit: string }
interface IntervalView { available: boolean; reason: string | null; distance: Quantity | null; volume: Quantity | null; economy: Quantity | null }
interface Draft { occurredAt: string; odometer: Quantity; volume: Quantity; full: boolean; missedPrevious?: boolean }
interface WebEconomy {
  Dec: { parse(v: string): WebDec; isDecimal(v: unknown): boolean };
  KM_PER: Record<string, WebDec>; L_PER: Record<string, WebDec>;
  toKm(v: WebDec, u: string): WebDec; toLitres(v: WebDec, u: string): WebDec; fromKm(v: WebDec, u: string): WebDec; fromLitres(v: WebDec, u: string): WebDec;
  economy(km: WebDec, l: WebDec, unit: string): WebDec | null;
  normalizeDecimal(s: string): string;
  checkDecimal(v: string, o: { maxScale: number; max: string; positive?: boolean }): string | null;
  checkOccurredAt(d: Date, now?: Date): string | null;
  RULES: Record<'odometer' | 'volume' | 'amount' | 'exchangeRate' | 'reportingAmount', { maxScale: number; max: string; positive?: boolean }>;
  intervals(fills: unknown[]): { endId: string; reason: string | null; available: boolean; distanceKm: WebDec; volumeL: WebDec; cost: WebDec | null }[];
  previewInterval(existing: unknown[], draft: Draft, prefs: Prefs): IntervalView;
  checkSequence(existing: unknown[], draft: Draft): { code: string; detail: string } | null;
  latestFill(existing: unknown[]): { odometer: Quantity } | null;
}
interface Prefs { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit; economyUnit: EconomyUnit }

const web = (await import(new URL('../../web/js/economy.js', import.meta.url).href)) as WebEconomy;

// Deterministic pseudo-random decimal strings, from tiny to huge.
function* cases(seed: number, count: number): Generator<string> {
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) % 2147483648; return s; };
  const fixed = ['0', '0.001', '0.0005', '1', '2.5', '7.505', '9999999', '9999999.999', '100000', '0.000000001', '12345678901234567890.123456789'];
  yield* fixed;
  for (let i = 0; i < count; i++) {
    const intLen = next() % 9, frac = next() % 7;
    const int = intLen === 0 ? '0' : String(1 + (next() % 9)) + Array.from({ length: intLen - 1 }, () => String(next() % 10)).join('');
    yield frac ? `${int}.${Array.from({ length: frac }, () => String(next() % 10)).join('')}` : int;
  }
}

test('decimal arithmetic and rounding match the server exactly', () => {
  const values = [...cases(7, 120)];
  for (let i = 0; i < values.length; i++) {
    const a = values[i]!, b = values[(i * 7 + 3) % values.length]!;
    const [sa, sb, wa, wb] = [Dec.parse(a), Dec.parse(b), web.Dec.parse(a), web.Dec.parse(b)];
    for (const scale of [0, 1, 2, 3, 6, 9]) {
      assert.equal(wa.add(wb).toFixed(scale), sa.add(sb).toFixed(scale), `${a} + ${b} @${scale}`);
      assert.equal(wa.sub(wb).toFixed(scale), sa.sub(sb).toFixed(scale), `${a} - ${b} @${scale}`);
      assert.equal(wa.mul(wb).toFixed(scale), sa.mul(sb).toFixed(scale), `${a} * ${b} @${scale}`);
      if (!sb.isZero()) assert.equal(wa.div(wb).toFixed(scale), sa.div(sb).toFixed(scale), `${a} / ${b} @${scale}`);
    }
    assert.equal(wa.toDecimal(12), sa.toDecimal(12));
    assert.equal(Math.sign(wa.cmp(wb)), Math.sign(sa.cmp(sb)));
  }
  // Half away from zero, the edge a float gets wrong.
  for (const [v, s, want] of [['1.005', 2, '1.01'], ['2.5', 0, '3'], ['-2.5', 0, '-3'], ['-0.004', 2, '0.00'], ['7.505', 2, '7.51']] as const) {
    assert.equal(web.Dec.parse(v).toFixed(s), want);
    assert.equal(Dec.parse(v).toFixed(s), want);
  }
  for (const bad of ['1e3', '.5', '1.', '', ' 1', '01', 'NaN', '1,5']) assert.equal(web.Dec.isDecimal(bad), Dec.isDecimal(bad), bad);
});

test('unit conversion and economy in every display unit match the server', () => {
  for (const u of ['km', 'mi'] as const) assert.equal(web.KM_PER[u]!.toDecimal(12), KM_PER[u].toDecimal(12));
  for (const u of ['l', 'gal_us', 'gal_imp'] as const) assert.equal(web.L_PER[u]!.toDecimal(12), L_PER[u].toDecimal(12));
  const values = [...cases(11, 60)].filter((v) => v !== '0');
  for (let i = 0; i < values.length; i++) {
    const km = values[i]!, l = values[(i * 5 + 1) % values.length]!;
    for (const u of ['km', 'mi'] as const) {
      assert.equal(web.toKm(web.Dec.parse(km), u).toFixed(6), toKm(Dec.parse(km), u).toFixed(6));
      assert.equal(web.fromKm(web.Dec.parse(km), u).toFixed(DISPLAY_SCALE.distance), fromKm(Dec.parse(km), u).toFixed(DISPLAY_SCALE.distance));
    }
    for (const u of ['l', 'gal_us', 'gal_imp'] as const) {
      assert.equal(web.toLitres(web.Dec.parse(l), u).toFixed(9), toLitres(Dec.parse(l), u).toFixed(9));
      assert.equal(web.fromLitres(web.Dec.parse(l), u).toFixed(DISPLAY_SCALE.volume), fromLitres(Dec.parse(l), u).toFixed(DISPLAY_SCALE.volume));
    }
    for (const e of ['l_per_100km', 'km_per_l', 'mpg_us', 'mpg_imp'] as const) {
      assert.equal(web.economy(web.Dec.parse(km), web.Dec.parse(l), e)!.toFixed(2), economy(Dec.parse(km), Dec.parse(l), e)!.toFixed(2), `${km} km ${l} L ${e}`);
    }
  }
  assert.equal(web.economy(web.Dec.parse('0'), web.Dec.parse('10'), 'mpg_us'), null);
  assert.equal(web.economy(web.Dec.parse('10'), web.Dec.parse('0'), 'km_per_l'), null);
});

test('field checks accept and refuse what the server does', () => {
  const inputs = ['0', '1', '42.5', '42.375', '42.3755', '-1', '05', '.5', '42.', '1e3', '9999999', '9999999.001', '100000', '100000.001', '0.000', '1000000000', '1000000000.0001', '1.0000000001', 'abc', ''];
  for (const [rule, o] of Object.entries(web.RULES)) {
    for (const v of inputs) {
      let server: string | null = null;
      try { decimal(v, 'x', o); } catch (e) { server = (e as Error).message; }
      assert.equal(web.checkDecimal(v, o) === null, server === null, `${rule} ${JSON.stringify(v)}: server ${server ?? 'accepts'}`);
    }
  }
  // A locale keypad's comma becomes a point before the check; nothing else is rewritten.
  assert.equal(web.normalizeDecimal(' 42,37 '), '42.37');
  assert.equal(web.checkDecimal(web.normalizeDecimal('48224,5'), web.RULES.odometer), null);
  assert.equal(web.checkDecimal(web.normalizeDecimal('1,234.5'), web.RULES.odometer), 'format');
  const now = new Date('2026-03-10T12:00:00Z');
  assert.equal(web.checkOccurredAt(new Date('2026-03-11T11:59:00Z'), now), null);
  assert.equal(web.checkOccurredAt(new Date('2026-03-11T12:01:00Z'), now), 'future');
  assert.equal(web.checkOccurredAt(new Date('1899-12-31T23:00:00Z'), now), 'past');
});

test('full-to-full intervals match the server on hand-made sequences', () => {
  const mk = (i: number, odo: string, vol: string, full = true, missed = false, cost: string | null = null) => ({ i, odo, vol, full, missed, cost });
  const sequences = [
    [mk(1, '10000', '45'), mk(2, '10250', '20', false), mk(3, '10500', '30')],
    [mk(1, '100', '10', false), mk(2, '200', '10', false), mk(3, '300', '10'), mk(4, '400', '30.02'), mk(5, '400', '5')],
    [mk(1, '0', '0.001'), mk(2, '0.001', '0.001'), mk(3, '9999999', '100000', true, true, '10'), mk(4, '9999999.999', '0.001', true, false, '1')],
    [mk(1, '5000', '40', true, false, '70'), mk(2, '5400', '30', false, false, null), mk(3, '5900', '35', true, false, '60')],
  ];
  for (const seq of sequences) {
    const server: Fill[] = seq.map((f) => ({
      id: `00000000-0000-7000-8000-${String(f.i).padStart(12, '0')}` as Id, occurredAt: new Date(Date.UTC(2026, 2, f.i)), odometerKm: Dec.parse(f.odo), volumeL: Dec.parse(f.vol),
      full: f.full, missedPrevious: f.missed, reportingCost: f.cost ? Dec.parse(f.cost) : null,
    }));
    const client = server.map((f) => ({ ...f, odometerKm: web.Dec.parse(f.odometerKm.toDecimal(9)), volumeL: web.Dec.parse(f.volumeL.toDecimal(9)), reportingCost: f.reportingCost && web.Dec.parse(f.reportingCost.toDecimal(9)) }));
    const a = intervals(server).map((i) => [i.endId, i.available, i.reason, i.distanceKm.toDecimal(12), i.volumeL.toDecimal(12), i.cost?.toDecimal(12) ?? null]);
    const b = web.intervals(client).map((i) => [i.endId, i.available, i.reason, i.distanceKm.toDecimal(12), i.volumeL.toDecimal(12), i.cost?.toDecimal(12) ?? null]);
    assert.deepEqual(b, a);
  }
});

// ---------- against the real service ----------
const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp, owner: TestUser;

before(async () => {
  db = await createTestDb();
  if (!db) return;
  owner = await createTestUser(db.pool);
  const vehicles = new VehicleService(db.pool);
  app = await startApp([owner], [...vehicleRoutes(vehicles), ...fuelRoutes(new FuelService(db.pool, vehicles)), ...preferenceRoutes(db.pool)]);
});
after(async () => { app?.close(); await db?.drop(); });

const day = (n: number, hour = 8) => new Date(Date.UTC(2026, 2, 1, hour) + n * 86_400_000).toISOString();
type Step = { at: string; odo: [string, DistanceUnit]; vol: [string, VolumeUnit]; full?: boolean; missed?: boolean; cost?: string };
const step = (n: number, odo: string, vol: string, over: Partial<Step> = {}): Step => ({ at: day(n), odo: [odo, 'km'], vol: [vol, 'l'], ...over });

/** Saves each step and checks the server's answer against what the phone predicted from the list it had. */
async function replay(name: string, prefs: Prefs, odometerUnit: DistanceUnit, steps: Step[]): Promise<number> {
  assert.equal((await app.call(owner, 'PUT', '/v1/preferences', { ...prefs, currency: 'EUR' })).status, 200);
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name, odometerUnit, currency: 'EUR' });
  assert.equal(v.status, 201, v.text);
  let compared = 0;
  for (const s of steps) {
    const existing = (await app.call(owner, 'GET', `/v1/vehicles/${v.json.id}/fill-ups?limit=5000`)).json.items;
    const draft: Draft = { occurredAt: s.at, odometer: { value: s.odo[0], unit: s.odo[1] }, volume: { value: s.vol[0], unit: s.vol[1] }, full: s.full ?? true, missedPrevious: s.missed ?? false };
    // Field checks first, as the server's parseFillUp runs before its sequence check.
    const badField = web.checkDecimal(s.odo[0], web.RULES.odometer) ?? web.checkDecimal(s.vol[0], web.RULES.volume);
    const refused = badField ? { code: 'validation_failed', detail: null } : web.checkSequence(existing, draft);
    const preview = refused ? null : web.previewInterval(existing, draft, prefs);
    const r = await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/fill-ups`, {
      occurredAt: s.at, odometer: draft.odometer, volume: draft.volume, full: draft.full, missedPrevious: draft.missedPrevious,
      cost: s.cost ? { amount: s.cost, currency: 'EUR' } : null,
    });
    const label = `${name}: ${JSON.stringify(s)}`;
    if (refused) {
      assert.deepEqual([r.status, r.json.code, refused.detail === null ? null : r.json.detail], [422, refused.code, refused.detail], label);
    } else {
      assert.equal(r.status, 201, `${label}: ${r.text}`);
      assert.deepEqual(preview, r.json.interval, label);
    }
    compared++;
  }
  return compared;
}

test('the preview equals the saved interval, and odometer refusals match, across units and edge cases', { skip }, async () => {
  const metric: Prefs = { distanceUnit: 'km', volumeUnit: 'l', economyUnit: 'l_per_100km' };
  let n = 0;
  // First fill (no previous), a partial, the interval closing, a half-way rounding (7.505 -> 7.51), no distance, missed fill.
  n += await replay('basic', metric, 'km', [
    step(0, '10000', '45.00'), step(1, '10250', '20', { full: false }), step(2, '10500', '30', { cost: '51.20' }),
    step(3, '10900', '30.02'), step(4, '10900', '5'), step(5, '11400', '33', { missed: true }), step(6, '11950', '38.123'),
    // Odometer going backwards: lower than an earlier record, then a backdate higher than a later one.
    step(7, '11000', '30'), step(3, '12000', '30', { at: day(3, 12) }),
    // A backdate that fits between its neighbours splits an interval.
    step(0, '10100', '4', { at: day(0, 20) }),
  ]);
  // Imperial units in, US and imperial gallons out, miles odometer.
  for (const economyUnit of ['mpg_us', 'mpg_imp', 'km_per_l'] as const) {
    n += await replay(`imperial-${economyUnit}`, { distanceUnit: 'mi', volumeUnit: economyUnit === 'mpg_imp' ? 'gal_imp' : 'gal_us', economyUnit }, 'mi', [
      step(0, '62137.119', '10', { odo: ['62137.119', 'mi'], vol: ['10', 'gal_us'] }),
      step(1, '100500', '10.000', { odo: ['100500', 'km'], vol: ['10.000', 'gal_imp'] }),
      step(2, '62500.001', '0.001', { odo: ['62500.001', 'mi'], vol: ['0.001', 'gal_us'], full: false }),
      step(3, '62800.333', '9.876', { odo: ['62800.333', 'mi'], vol: ['9.876', 'gal_us'] }),
      step(4, '62700', '5', { odo: ['62700', 'mi'], vol: ['5', 'gal_imp'] }),
    ]);
  }
  // Very small and very large values: the smallest steps the contract allows and the largest readings.
  n += await replay('extremes', metric, 'km', [
    step(0, '0', '0.001'), step(1, '0.001', '0.001'), step(2, '0.002', '100000'), step(3, '9999998.999', '100000'), step(4, '9999999', '0.001'),
    // Just past the limits: refused by both.
    step(5, '9999999.001', '1'), step(6, '9999999', '100000.001'), step(7, '9999999', '0'),
  ]);
  assert.ok(n >= 25, `compared ${n} saves`);
});

test('the latest reading prefills from the newest record in authoritative order', { skip }, async () => {
  const v = (await app.call(owner, 'POST', '/v1/vehicles', { name: 'Prefill', odometerUnit: 'km', currency: 'EUR' })).json;
  const add = (at: string, odo: string) => app.call(owner, 'POST', `/v1/vehicles/${v.id}/fill-ups`, { occurredAt: at, odometer: { value: odo, unit: 'km' }, volume: { value: '10', unit: 'l' } });
  await add(day(5), '2000'); await add(day(1), '1000'); await add(day(5), '2100');
  const items = (await app.call(owner, 'GET', `/v1/vehicles/${v.id}/fill-ups`)).json.items;
  assert.equal(web.latestFill(items)!.odometer.value, items[0].odometer.value, 'matches the server newest-first order');
  assert.equal(web.latestFill([]), null);
});
