import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { imageRoutes, MAX_IMAGE_BYTES } from '../src/vehicles/images.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { PortabilityService, MAX_IMPORT_ROWS } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { parseCsv, toCsv, neutralise, denormalise, CsvError } from '../src/portability/csv.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';
import { jpeg, JFIF, png } from './helpers/images.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

// Two separate databases stand in for two instances.
interface Instance { db: TestDb; app: TestApp; owner: TestUser; editor: TestUser; viewer: TestUser; stranger: TestUser }
let a: Instance, b: Instance;

async function instance(): Promise<Instance> {
  const db = (await createTestDb())!;
  const [owner, editor, viewer, stranger] = await Promise.all([createTestUser(db.pool), createTestUser(db.pool), createTestUser(db.pool), createTestUser(db.pool)]) as [TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles);
  const app = await startApp([owner, editor, viewer, stranger], [
    ...vehicleRoutes(vehicles), ...imageRoutes(db.pool, vehicles), ...fuelRoutes(fuel), ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel)),
  ]);
  return { db, app, owner, editor, viewer, stranger };
}
before(async () => { if (!skip) [a, b] = await Promise.all([instance(), instance()]); });
after(async () => { for (const i of [a, b]) { i?.app.close(); await i?.db.drop(); } });

const day = (n: number) => `2026-04-${String(n).padStart(2, '0')}T07:30:00.000Z`;
async function seeded(i: Instance): Promise<string> {
  const v = (await i.app.call(i.owner, 'POST', '/v1/vehicles', { name: 'Road Trip', make: 'Volvo', model: 'V60', year: 2021, odometerUnit: 'mi', currency: 'EUR' })).json.id as string;
  await i.app.call(i.owner, 'POST', `/v1/vehicles/${v}/members`, { userId: i.editor.id, role: 'editor' });
  await i.app.call(i.owner, 'POST', `/v1/vehicles/${v}/members`, { userId: i.viewer.id, role: 'viewer' });
  const fills = [
    { occurredAt: day(1), odometer: { value: '20000', unit: 'mi' }, volume: { value: '12.50', unit: 'gal_us' }, cost: { amount: '61.25', currency: 'EUR' }, notes: '=HYPERLINK("http://evil.test","click")' },
    { occurredAt: day(5), odometer: { value: '20210.5', unit: 'mi' }, volume: { value: '6', unit: 'gal_imp' }, full: false, notes: 'cash, "quoted", comma\nnew line' },
    { occurredAt: day(9), odometer: { value: '33000', unit: 'km' }, volume: { value: '41.3', unit: 'l' }, cost: { amount: '70.00', currency: 'CHF', exchangeRate: '1.05' }, missedPrevious: true, notes: "'=already quoted" },
    { occurredAt: day(12), odometer: { value: '20900', unit: 'mi' }, volume: { value: '11', unit: 'gal_us' }, notes: '-5 discount +tip @home' },
  ];
  for (const f of fills) assert.equal((await i.app.call(i.owner, 'POST', `/v1/vehicles/${v}/fill-ups`, f)).status, 201);
  return v;
}
const records = async (i: Instance, who: TestUser, v: string) =>
  (await i.app.call(who, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.items.map((f: any) => ({
    occurredAt: f.occurredAt, odometer: f.odometer, volume: f.volume, full: f.full, missedPrevious: f.missedPrevious, notes: f.notes,
    cost: f.cost && { amount: f.cost.amount, currency: f.cost.currency, exchangeRate: f.cost.exchangeRate, reportingAmount: f.cost.reportingAmount }, interval: f.interval,
  }));

test('CSV reader and writer: quoting, line endings, BOM, malformed input', () => {
  const rows = [['a', 'b, c', 'say "hi"', 'two\nlines', ' padded ', '']];
  assert.deepEqual(parseCsv(toCsv(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], rows), 10).slice(1), rows);
  assert.deepEqual(parseCsv('﻿x,y\n1,2\r\n\r\n3,4', 10), [['x', 'y'], ['1', '2'], ['3', '4']]);
  assert.throws(() => parseCsv('a,"unterminated', 10), CsvError);
  assert.throws(() => parseCsv('a,"x"y', 10), CsvError);
  assert.throws(() => parseCsv('a,b"c', 10), CsvError);
  assert.throws(() => parseCsv('h\n1\n2\n3', 2), CsvError);
});

test('formula neutralisation is applied to every risky leading character and is reversible', () => {
  for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
    assert.equal(neutralise(v), `'${v}`);
    assert.equal(denormalise(neutralise(v)), v);
  }
  for (const v of ['plain', '1=1', '']) assert.equal(neutralise(v), v);
  for (const v of ["'quoted", "'=already", "''twice", "'"]) assert.equal(denormalise(neutralise(v)), v, 'text that starts with an apostrophe survives');
});

test('CSV export neutralises formulas and never starts a cell with a formula character', { skip }, async () => {
  const v = await seeded(a);
  const res = await a.app.call(a.viewer, 'GET', `/v1/vehicles/${v}/export?format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/csv/);
  assert.match(res.headers.get('content-disposition')!, /^attachment; filename="driveloom-road-trip-\d{4}-\d{2}-\d{2}\.csv"$/);
  const rows = parseCsv(res.text, 100);
  assert.equal(rows.length, 5);
  for (const row of rows.slice(1)) for (const cell of row) assert.ok(!/^[=+\-@\t\r]/.test(cell), `unsafe cell: ${cell}`);
  assert.equal(rows[1]![12], `'=HYPERLINK("http://evil.test","click")`);
  assert.equal((await a.app.call(a.stranger, 'GET', `/v1/vehicles/${v}/export?format=csv`)).status, 404);
  assert.equal((await a.app.call(a.viewer, 'GET', `/v1/vehicles/${v}/export?format=xml`)).status, 422);
});

for (const format of ['csv', 'json'] as const) {
  test(`cross-instance ${format} round trip: preview writes nothing, commit reproduces every record, re-import is a no-op`, { skip }, async () => {
    const src = await seeded(a);
    const exported = await a.app.call(a.owner, 'GET', `/v1/vehicles/${src}/export?format=${format}`);
    const data = format === 'csv' ? exported.text : JSON.parse(exported.text);
    const dst = (await b.app.call(b.owner, 'POST', '/v1/vehicles', { name: 'Imported', odometerUnit: 'mi', currency: 'EUR' })).json.id as string;

    const preview = await b.app.call(b.owner, 'POST', `/v1/vehicles/${dst}/import`, { format, data });
    assert.equal(preview.status, 200, preview.text);
    assert.deepEqual(preview.json, { dryRun: true, committed: false, summary: { total: 4, created: 4, duplicates: 0, invalid: 0 }, errors: [] });
    assert.equal((await b.app.call(b.owner, 'GET', `/v1/vehicles/${dst}/fill-ups`)).json.total, 0, 'a dry run leaves no rows');

    const commit = await b.app.call(b.owner, 'POST', `/v1/vehicles/${dst}/import`, { format, data, dryRun: false });
    assert.deepEqual(commit.json.summary, { total: 4, created: 4, duplicates: 0, invalid: 0 });
    assert.equal(commit.json.committed, true);
    assert.deepEqual(await records(b, b.owner, dst), await records(a, a.owner, src), 'values, units, costs, notes and intervals match the source');

    const again = await b.app.call(b.owner, 'POST', `/v1/vehicles/${dst}/import`, { format, data, dryRun: false });
    assert.deepEqual(again.json.summary, { total: 4, created: 0, duplicates: 4, invalid: 0 });
    assert.equal((await b.app.call(b.owner, 'GET', `/v1/vehicles/${dst}/fill-ups`)).json.total, 4);
  });
}

test('JSON export creates a new vehicle owned by the importer; nothing about source users crosses', { skip }, async () => {
  const src = await seeded(a);
  const text = (await a.app.call(a.owner, 'GET', `/v1/vehicles/${src}/export?format=json`)).text;
  for (const secret of [a.owner.id, a.editor.id, a.owner.email, src]) assert.ok(!text.includes(secret), 'no ids or emails in the export');
  const data = JSON.parse(text);
  assert.deepEqual([data.format, data.version], ['driveloom.vehicle', 1]);
  const preview = await b.app.call(b.stranger, 'POST', '/v1/vehicle-imports', { data });
  assert.deepEqual([preview.json.committed, preview.json.vehicle], [false, undefined]);
  assert.equal((await b.app.call(b.stranger, 'GET', '/v1/vehicles')).json.items.length, 0);
  const done = await b.app.call(b.stranger, 'POST', '/v1/vehicle-imports', { data, dryRun: false });
  assert.equal(done.json.committed, true);
  const v = done.json.vehicle;
  assert.deepEqual([v.name, v.make, v.model, v.year, v.odometerUnit, v.currency, v.role], ['Road Trip', 'Volvo', 'V60', 2021, 'mi', 'EUR', 'owner']);
  assert.deepEqual(await records(b, b.stranger, v.id), await records(a, a.owner, src));
  assert.equal((await b.app.call(b.owner, 'GET', `/v1/vehicles/${v.id}`)).status, 404, 'imported into the importer\'s permissions only');
  for (const bad of [{ ...data, version: 2 }, { ...data, format: 'other' }, { ...data, fillUps: 'x' }, [], 'text']) {
    assert.equal((await b.app.call(b.stranger, 'POST', '/v1/vehicle-imports', { data: bad })).status, 422);
  }
  assert.equal((await b.app.call(b.stranger, 'POST', '/v1/vehicle-imports', { data: { ...data, version: 2 } })).json.code, 'unsupported_version');
});

test('a reporting amount is not trusted across currencies', { skip }, async () => {
  const src = await seeded(a);
  const data = (await a.app.call(a.owner, 'GET', `/v1/vehicles/${src}/export?format=csv`)).text;
  const usd = (await b.app.call(b.owner, 'POST', '/v1/vehicles', { name: 'USD car', currency: 'USD' })).json.id as string;
  const r = await b.app.call(b.owner, 'POST', `/v1/vehicles/${usd}/import`, { format: 'csv', data });
  // Both costed rows were reported in EUR; the destination reports in USD, so each needs a rate.
  assert.deepEqual(r.json.summary, { total: 4, created: 2, duplicates: 0, invalid: 2 });
  assert.deepEqual(r.json.errors.map((e: any) => e.code), ['reporting_amount_required', 'reporting_amount_required']);
});

test('invalid, malformed, oversized and unauthorized imports change nothing', { skip }, async () => {
  const v = (await b.app.call(b.owner, 'POST', '/v1/vehicles', { name: 'Target', currency: 'EUR' })).json.id as string;
  await b.app.call(b.owner, 'POST', `/v1/vehicles/${v}/members`, { userId: b.viewer.id, role: 'viewer' });
  await b.app.call(b.owner, 'POST', `/v1/vehicles/${v}/fill-ups`, { occurredAt: day(10), odometer: { value: '5000', unit: 'km' }, volume: { value: '40', unit: 'l' } });
  const head = 'occurred_at,odometer,odometer_unit,volume,volume_unit';
  const post = (data: unknown, extra: Record<string, unknown> = {}, as = b.owner) => b.app.call(as, 'POST', `/v1/vehicles/${v}/import`, { format: 'csv', data, ...extra });

  const mixed = `${head}\n${day(11)},5400,km,30,l\n${day(12)},5300,km,30,l\nnot-a-date,1,km,1,l\n${day(13)},5900,furlongs,30,l\n${day(14)},6000,km,-3,l`;
  const preview = await post(mixed);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.summary, { total: 5, created: 1, duplicates: 0, invalid: 4 });
  assert.deepEqual(preview.json.errors.map((e: any) => [e.row, e.code]), [[3, 'validation_failed'], [4, 'validation_failed'], [5, 'validation_failed'], [2, 'odometer_out_of_sequence']]);
  const commit = await post(mixed, { dryRun: false });
  assert.deepEqual([commit.status, commit.json.code, commit.json.report.summary.invalid], [422, 'import_invalid', 4]);
  assert.equal((await b.app.call(b.owner, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.total, 1, 'all-or-nothing: the valid row was not kept');

  for (const [data, code] of [
    ['', 'import_malformed'], [`${head}\n"unterminated`, 'import_malformed'], [`${head},bogus\n`, 'import_malformed'],
    ['occurred_at,odometer\n', 'import_malformed'], [`${head},${head}\n`, 'import_malformed'],
    [`${head}\n` + `${day(15)},7000,km,1,l\n`.repeat(MAX_IMPORT_ROWS + 1), 'import_malformed'],
  ] as const) {
    const r = await post(data);
    assert.deepEqual([r.status, r.json.code], [422, code], data.slice(0, 40));
  }
  assert.equal((await post(42)).status, 422);
  assert.equal((await b.app.call(b.owner, 'POST', `/v1/vehicles/${v}/import`, { format: 'xml', data: '' })).status, 422);
  assert.equal((await post(`${head}\n`, { dryRun: 'no' })).status, 422);
  const big = await post('x'.repeat(9 * 1024 * 1024));
  assert.deepEqual([big.status, big.json.code], [413, 'body_too_large']);
  assert.equal((await post(`${head}\n${day(11)},5400,km,30,l`, { dryRun: false }, b.viewer)).status, 403);
  assert.equal((await post(`${head}\n${day(11)},5400,km,30,l`, { dryRun: false }, b.stranger)).status, 404);
  assert.equal((await b.app.call(b.owner, 'GET', `/v1/vehicles/${v}/fill-ups`)).json.total, 1);
  // A file that lists the same purchase twice imports it once.
  const twice = await post(`${head}\n${day(11)},5400,km,30,l\n${day(11)},5400.0,km,30,l`, { dryRun: false });
  assert.deepEqual(twice.json.summary, { total: 2, created: 1, duplicates: 1, invalid: 0 });
});

const PNG = png();
const JPEG = jpeg(JFIF);

test('vehicle images: members only, type from content, size limit, replace and remove', { skip }, async () => {
  const v = await seeded(a);
  const put = (as: TestUser | null, data: Buffer, type = 'image/png') => a.app.call(as, 'PUT', `/v1/vehicles/${v}/image`, new Uint8Array(data), { 'content-type': type });
  assert.equal((await a.app.call(a.owner, 'GET', `/v1/vehicles/${v}/image`)).status, 404);
  assert.equal((await a.app.call(a.owner, 'GET', `/v1/vehicles/${v}`)).json.imageVersion, null);
  assert.equal((await put(a.viewer, PNG)).status, 403);
  assert.equal((await put(a.stranger, PNG)).status, 404);
  assert.equal((await put(null, PNG)).status, 401);
  assert.equal((await put(a.editor, Buffer.from('<svg onload=alert(1)>'), 'image/png')).status, 422, 'content decides, not the header');
  assert.equal((await put(a.editor, PNG, 'image/svg+xml')).status, 415);
  assert.equal((await put(a.editor, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))).status, 413);
  assert.equal((await put(a.editor, PNG)).status, 204);
  const got = await a.app.call(a.viewer, 'GET', `/v1/vehicles/${v}/image`);
  assert.deepEqual([got.status, got.type, got.bytes.equals(PNG)], [200, 'image/png', true]);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-security-policy')!, /default-src 'none'/);
  const v1 = (await a.app.call(a.owner, 'GET', `/v1/vehicles/${v}`)).json.imageVersion;
  assert.match(v1, /^\d+$/);
  assert.equal((await put(a.owner, JPEG, 'image/png')).status, 204, 'declared png, stored as what it is');
  assert.equal((await a.app.call(a.owner, 'GET', `/v1/vehicles/${v}/image`)).type, 'image/jpeg');
  assert.equal((await a.app.call(a.stranger, 'GET', `/v1/vehicles/${v}/image`)).status, 404);
  assert.equal((await a.app.call(a.viewer, 'DELETE', `/v1/vehicles/${v}/image`)).status, 403);
  assert.equal((await a.app.call(a.editor, 'DELETE', `/v1/vehicles/${v}/image`)).status, 204);
  assert.equal((await a.app.call(a.editor, 'DELETE', `/v1/vehicles/${v}/image`)).status, 404);
});
