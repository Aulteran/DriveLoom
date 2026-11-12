import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Dec } from '../src/decimal.ts';
import { currencyScale, economy, fromKm, fromLitres, isCurrency, KM_PER, L_PER, toKm, toLitres } from '../src/units.ts';
import { aggregate, intervals, type Fill } from '../src/fuel/economy.ts';
import { uuidv7 } from '../src/ids.ts';
import type { DistanceUnit, VolumeUnit } from '../src/types.ts';

const fx = JSON.parse(await readFile(new URL('./fixtures/decimal-cases.json', import.meta.url), 'utf8'));
const d = (s: string) => Dec.parse(s);

test('Dec parses exact strings only and never accepts JS numbers', () => {
  for (const bad of [1.5, '1e3', '.5', '1.', '', ' 1', '01', 'NaN', null]) assert.throws(() => Dec.parse(bad as never), TypeError, String(bad));
  assert.equal(d('0.1').add(d('0.2')).toFixed(1), '0.3'); // the classic float failure
  assert.equal(d('0.1').add(d('0.2')).cmp(d('0.3')), 0);
});

test('rounding is half away from zero, at display only', () => {
  assert.equal(d('2.5').toFixed(0), '3');
  assert.equal(d('-2.5').toFixed(0), '-3');
  assert.equal(d('1.005').toFixed(2), '1.01');
  assert.equal(d('1.0049999').toFixed(2), '1.00');
  assert.equal(d('-0.004').toFixed(2), '0.00');
  assert.equal(d('1').div(d('3')).toFixed(4), '0.3333');
  assert.equal(d('2').div(d('3')).toFixed(4), '0.6667');
  assert.equal(d('10.500').toDecimal(6), '10.5');
  assert.equal(d('7').div(d('-2')).toFixed(1), '-3.5');
});

test('conversion constants match the contract and are exact', () => {
  assert.equal(KM_PER.mi.toDecimal(12), fx.units.mi_to_km);
  assert.equal(L_PER.gal_us.toDecimal(12), fx.units.gal_us_to_l);
  assert.equal(L_PER.gal_imp.toDecimal(12), fx.units.gal_imp_to_l);
  for (const r of fx.roundTrips) assert.equal(toLitres(d(r.input), r.unit as VolumeUnit).toDecimal(12), r.storedL);
});

test('unit round trips return the original value exactly', () => {
  for (const v of ['0.001', '1', '12.345', '99999.999']) {
    for (const u of ['km', 'mi'] as DistanceUnit[]) assert.equal(fromKm(toKm(d(v), u), u).cmp(d(v)), 0, `${v} ${u}`);
    for (const u of ['l', 'gal_us', 'gal_imp'] as VolumeUnit[]) assert.equal(fromLitres(toLitres(d(v), u), u).cmp(d(v)), 0, `${v} ${u}`);
  }
});

test('economy units: both gallons, L/100 km and km/L from the same aggregate', () => {
  const km = d('500'), l = d('50');
  assert.equal(economy(km, l, 'l_per_100km')!.toFixed(2), '10.00');
  assert.equal(economy(km, l, 'km_per_l')!.toFixed(2), '10.00');
  assert.equal(economy(km, l, 'mpg_us')!.toFixed(2), '23.52'); // 235.214583 / 10
  assert.equal(economy(km, l, 'mpg_imp')!.toFixed(2), '28.25'); // 282.480936 / 10
  assert.equal(economy(Dec.ZERO, l, 'mpg_us'), null);
  assert.equal(economy(km, Dec.ZERO, 'km_per_l'), null);
});

test('currency codes and minor units', () => {
  assert.ok(isCurrency('EUR'));
  for (const bad of ['eur', 'EU', 'XXQ', 5, 'EURO']) assert.ok(!isCurrency(bad), String(bad));
  assert.equal(currencyScale('USD'), 2);
  assert.equal(currencyScale('JPY'), 0);
  assert.equal(currencyScale('KWD'), 3);
});

let t = Date.parse('2026-01-01T00:00:00Z');
const fill = (odometer: string, volume: string, full: boolean, o: Partial<Fill> = {}): Fill =>
  ({ id: uuidv7(), occurredAt: new Date((t += 86_400_000)), odometerKm: d(odometer), volumeL: d(volume), full, missedPrevious: false, reportingCost: null, ...o });

test('full-to-full fixture: starting fill excluded, partial and closing fill included', () => {
  const f = fx.fullToFull;
  const list = [fill(f.start.odometer, '45', true), ...f.fills.map((x: { odometer: string; volume: string; full: boolean }) => fill(x.odometer, x.volume, x.full))];
  const iv = intervals(list);
  assert.equal(iv.length, 2);
  assert.deepEqual([iv[0]!.available, iv[0]!.reason], [false, 'no_previous_full_fill']);
  assert.equal(iv[1]!.available, true);
  assert.equal(iv[1]!.distanceKm.toDecimal(6), f.expected.distanceKm);
  assert.equal(iv[1]!.volumeL.toDecimal(6), f.expected.volumeL);
  assert.equal(economy(iv[1]!.distanceKm, iv[1]!.volumeL, 'l_per_100km')!.toDecimal(6), f.expected.lPer100km);
});

test('incomplete interval fixture is unavailable, not estimated', () => {
  const iv = intervals(fx.incompleteInterval.fills.map((x: { odometer: string; volume: string; full: boolean }) => fill(x.odometer, x.volume, x.full)));
  assert.equal(iv.filter((i) => i.available).length, 0);
  assert.equal(aggregate(iv).intervalCount, 0);
});

test('a missed fill voids only its own interval; zero distance is unavailable', () => {
  const list = [fill('1000', '40', true), fill('1500', '30', true, { missedPrevious: true }), fill('2000', '35', true), fill('2000', '5', true)];
  const iv = intervals(list);
  assert.deepEqual(iv.map((i) => i.reason), ['no_previous_full_fill', 'missed_fill', null, 'no_distance']);
  const a = aggregate(iv);
  assert.equal(a.intervalCount, 1);
  assert.equal(economy(a.distanceKm, a.volumeL, 'l_per_100km')!.toFixed(2), '7.00');
});

test('aggregate sums distance and volume before dividing', () => {
  // 100 km on 10 L and 900 km on 45 L: mean of ratios would be 7.5, the aggregate is 5.5.
  const iv = intervals([fill('0', '1', true), fill('100', '10', true), fill('1000', '45', true)]);
  const a = aggregate(iv);
  assert.equal(economy(a.distanceKm, a.volumeL, 'l_per_100km')!.toFixed(2), '5.50');
});

test('interval cost is known only when every purchase in it has a cost', () => {
  const c = (v: string) => ({ reportingCost: d(v) });
  const iv = intervals([fill('0', '1', true), fill('100', '5', false, c('8')), fill('200', '5', true, c('9')), fill('300', '5', false), fill('400', '5', true, c('9'))]);
  assert.equal(iv[1]!.cost!.toFixed(2), '17.00');
  assert.equal(iv[2]!.cost, null);
  const a = aggregate(iv);
  assert.equal(a.cost.toFixed(2), '17.00');
  assert.equal(a.costDistanceKm.toFixed(0), '200');
});
