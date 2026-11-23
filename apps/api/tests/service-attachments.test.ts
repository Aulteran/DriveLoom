// Service attachments: upload per type, magic-byte validation, limits, download
// headers, role matrix, non-member and module-off 404, rename/delete, cascade,
// export/import round trip and filename sanitisation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VehicleService } from '../src/vehicles/service.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { FuelService } from '../src/fuel/service.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { ServiceService } from '../src/service/service.ts';
import { serviceRoutes } from '../src/service/routes.ts';
import { AttachmentService, attachmentRoutes } from '../src/service/attachments.ts';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_VISIT, contentDisposition, sanitiseFileName } from '../src/service/attachment-limits.ts';
import { PortabilityService } from '../src/portability/service.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { setModule } from '../src/modules.ts';
import { createTestDb, createTestUser, type TestDb, type TestUser } from './helpers/index.ts';
import { startApp, type TestApp } from './helpers/http.ts';
import { png, jpeg } from './helpers/images.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
let db: TestDb | null, app: TestApp;
let owner: TestUser, editor: TestUser, driver: TestUser, driver2: TestUser, viewer: TestUser, stranger: TestUser;

before(async () => {
  db = await createTestDb();
  if (!db) return;
  [owner, editor, driver, driver2, viewer, stranger] = await Promise.all(Array.from({ length: 6 }, () => createTestUser(db!.pool))) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  const vehicles = new VehicleService(db.pool), fuel = new FuelService(db.pool, vehicles), service = new ServiceService(db.pool, vehicles);
  app = await startApp([owner, editor, driver, driver2, viewer, stranger], [
    ...vehicleRoutes(vehicles), ...fuelRoutes(fuel), ...serviceRoutes(service), ...attachmentRoutes(new AttachmentService(db.pool, vehicles)),
    ...portabilityRoutes(new PortabilityService(db.pool, vehicles, fuel, service)),
  ]);
  await setModule(db.pool, 'service', true);
});
after(async () => { app?.close(); await db?.drop(); });

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n%receipt\n'), Buffer.alloc(200, 7), Buffer.from('\n%%EOF\n')]);
const PNG = png(), JPG = jpeg();

async function vehicle(): Promise<string> {
  const v = await app.call(owner, 'POST', '/v1/vehicles', { name: 'Car', odometerUnit: 'km', currency: 'EUR' });
  assert.equal(v.status, 201, v.text);
  for (const [u, role] of [[editor, 'editor'], [driver, 'driver'], [driver2, 'driver'], [viewer, 'viewer']] as const) {
    await app.call(owner, 'POST', `/v1/vehicles/${v.json.id}/members`, { userId: u.id, role });
  }
  return v.json.id;
}
async function visit(v: string, as: TestUser = owner): Promise<string> {
  const r = await app.call(as, 'POST', `/v1/vehicles/${v}/service-visits`, { servicedOn: '2026-03-10', items: [{ name: 'Oil change' }] });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}
const base = (v: string, s: string, a = '') => `/v1/vehicles/${v}/service-visits/${s}/attachments${a ? `/${a}` : ''}`;
const up = (v: string, s: string, data: Uint8Array, name: string | null, type = 'application/octet-stream', as: TestUser = owner) =>
  app.call(as, 'POST', `${base(v, s)}${name === null ? '' : `?fileName=${encodeURIComponent(name)}`}`, data, { 'content-type': type });
const get = (v: string, s: string) => app.call(owner, 'GET', `/v1/vehicles/${v}/service-visits/${s}`);

test('upload each type, list in the visit, download the exact bytes with safe headers', { skip }, async () => {
  const v = await vehicle(), s = await visit(v);
  const a = await up(v, s, PDF, 'invoice.pdf', 'application/pdf');
  assert.equal(a.status, 201, a.text);
  assert.deepEqual(Object.keys(a.json).sort(), ['contentType', 'createdAt', 'fileName', 'id', 'sizeBytes']);
  assert.equal(a.json.contentType, 'application/pdf');
  assert.equal(a.json.sizeBytes, PDF.length);
  const b = await up(v, s, PNG, 'photo.png', 'image/png');
  const c = await up(v, s, JPG, 'photo.jpg', 'application/octet-stream');
  assert.equal(b.json.contentType, 'image/png'); assert.equal(c.json.contentType, 'image/jpeg');
  const got = await get(v, s);
  assert.deepEqual(got.json.attachments.map((x: any) => x.fileName), ['invoice.pdf', 'photo.png', 'photo.jpg']);
  assert.ok(!JSON.stringify(got.json).includes('data'), 'no bytes in the visit');
  const list = await app.call(owner, 'GET', `/v1/vehicles/${v}/service-visits`);
  assert.equal(list.json.items[0].attachments.length, 3);

  for (const [att, bytes, type] of [[a, PDF, 'application/pdf'], [b, PNG, 'image/png'], [c, JPG, 'image/jpeg']] as const) {
    const d = await app.call(viewer, 'GET', base(v, s, att.json.id));
    assert.equal(d.status, 200);
    assert.ok(d.bytes.equals(bytes));
    assert.equal(d.type, type);
    assert.match(d.headers.get('content-disposition')!, /^attachment; filename="/);
    assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(d.headers.get('cache-control'), 'private, no-store');
    const i = await app.call(viewer, 'GET', `${base(v, s, att.json.id)}?inline=1`);
    assert.match(i.headers.get('content-disposition')!, /^inline; filename="/);
    assert.equal(i.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  }
  assert.equal(createHash('sha256').update(PDF).digest('hex').length, 64);
});

test('magic bytes decide: wrong content, mismatching claims and empty bodies are refused', { skip }, async () => {
  const v = await vehicle(), s = await visit(v);
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]);
  assert.equal((await up(v, s, exe, 'receipt.pdf', 'application/pdf')).status, 422);
  assert.equal((await up(v, s, Buffer.from('hello, not an image'), 'a.png', 'image/png')).status, 422);
  assert.equal((await up(v, s, PNG, 'a.pdf', 'application/pdf')).status, 422, 'png claimed as pdf');
  assert.equal((await up(v, s, Buffer.alloc(0), 'a.pdf', 'application/pdf')).status, 422);
  assert.equal((await up(v, s, PDF, 'a.pdf', 'text/html')).status, 415);
  assert.equal((await get(v, s)).json.attachments.length, 0);
  // The name's extension is irrelevant.
  assert.equal((await up(v, s, PDF, 'looks.exe', 'application/pdf')).json.contentType, 'application/pdf');
});

test('size and per-visit limits', { skip }, async () => {
  const v = await vehicle(), s = await visit(v);
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
  assert.equal((await up(v, s, big, 'big.pdf', 'application/pdf')).status, 413);
  const edge = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_ATTACHMENT_BYTES - 5)]);
  assert.equal(edge.length, MAX_ATTACHMENT_BYTES);
  assert.equal((await up(v, s, edge, 'edge.pdf', 'application/pdf')).status, 201);
  for (let i = 1; i < MAX_ATTACHMENTS_PER_VISIT; i++) assert.equal((await up(v, s, PNG, `n${i}.png`, 'image/png')).status, 201);
  const over = await up(v, s, PNG, 'over.png', 'image/png');
  assert.equal(over.status, 422); assert.equal(over.json.code, 'attachment_limit');
  assert.equal((await get(v, s)).json.attachments.length, MAX_ATTACHMENTS_PER_VISIT);
  // Another visit has its own allowance.
  assert.equal((await up(v, await visit(v), PNG, 'ok.png', 'image/png')).status, 201);
});

test('role matrix, non-members and archived vehicles', { skip }, async () => {
  const v = await vehicle();
  const mine = await visit(v, driver), others = await visit(v, owner);
  assert.equal((await up(v, mine, PNG, 'a.png', 'image/png', driver)).status, 201);
  assert.equal((await up(v, others, PNG, 'a.png', 'image/png', driver)).status, 403, 'driver on a manager visit');
  assert.equal((await up(v, mine, PNG, 'a.png', 'image/png', driver2)).status, 403, 'other driver');
  assert.equal((await up(v, mine, PNG, 'a.png', 'image/png', viewer)).status, 403);
  const e = await up(v, mine, PNG, 'e.png', 'image/png', editor);
  assert.equal(e.status, 201);
  assert.equal((await up(v, mine, PNG, 'a.png', 'image/png', stranger)).status, 404);
  // Everyone in the vehicle reads; strangers do not.
  for (const u of [owner, editor, driver, driver2, viewer]) assert.equal((await app.call(u, 'GET', base(v, mine, e.json.id))).status, 200);
  assert.equal((await app.call(stranger, 'GET', base(v, mine, e.json.id))).status, 404);
  assert.equal((await app.call(null, 'GET', base(v, mine, e.json.id))).status, 401);
  // Changes
  for (const [u, st] of [[viewer, 403], [driver2, 403], [stranger, 404], [driver, 200]] as const) {
    assert.equal((await app.call(u, 'PATCH', base(v, mine, e.json.id), { fileName: 'x.png' })).status, st, `rename as ${st}`);
  }
  assert.equal((await app.call(driver, 'DELETE', base(v, others, 'x'))).status, 403);
  assert.equal((await app.call(viewer, 'DELETE', base(v, mine, e.json.id))).status, 403);
  // Wrong visit/vehicle pairing never leaks.
  const v2 = await vehicle(), s2 = await visit(v2);
  assert.equal((await app.call(owner, 'GET', base(v2, s2, e.json.id))).status, 404);
  assert.equal((await app.call(owner, 'GET', base(v, others, e.json.id))).status, 404);
  // Archived: reads continue, changes refused.
  assert.equal((await app.call(owner, 'PUT', `/v1/vehicles/${v}/archive`, { archived: true })).status, 200);
  assert.equal((await up(v, mine, PNG, 'z.png', 'image/png')).status, 409);
  assert.equal((await app.call(owner, 'GET', base(v, mine, e.json.id))).status, 200);
});

test('rename, delete, audit events and cascade on visit and vehicle delete', { skip }, async () => {
  const v = await vehicle(), s = await visit(v);
  const a = await up(v, s, PNG, 'old.png', 'image/png');
  const r = await app.call(owner, 'PATCH', base(v, s, a.json.id), { fileName: '../../Receipt 2026.png' });
  assert.equal(r.status, 200); assert.equal(r.json.fileName, 'Receipt 2026.png');
  assert.equal((await app.call(owner, 'PATCH', base(v, s, a.json.id), { fileName: '///' })).status, 422);
  assert.equal((await app.call(owner, 'PATCH', base(v, s, a.json.id), { fileName: 'x', extra: 1 })).status, 422);
  const b = await up(v, s, JPG, 'b.jpg', 'image/jpeg');
  assert.equal((await app.call(owner, 'DELETE', base(v, s, b.json.id))).status, 204);
  assert.equal((await app.call(owner, 'DELETE', base(v, s, b.json.id))).status, 404);
  const actions = (await db!.pool.query("SELECT action FROM audit_events WHERE action LIKE 'service_attachment.%' AND subject_id = $1 ORDER BY id", [v])).rows.map((x) => x.action);
  assert.deepEqual(actions, ['service_attachment.add', 'service_attachment.rename', 'service_attachment.add', 'service_attachment.delete']);
  assert.equal((await db!.pool.query('SELECT count(*)::int n FROM service_attachments WHERE visit_id = $1', [s])).rows[0].n, 1);
  assert.equal((await app.call(owner, 'DELETE', `/v1/vehicles/${v}/service-visits/${s}`)).status, 204);
  assert.equal((await db!.pool.query('SELECT count(*)::int n FROM service_attachments WHERE visit_id = $1', [s])).rows[0].n, 0);
  const s2 = await visit(v); await up(v, s2, PNG, 'c.png', 'image/png');
  // There is no vehicle delete endpoint; the schema cascade must still hold (e.g. for a future purge).
  await db!.pool.query('DELETE FROM vehicles WHERE id = $1', [v]);
  assert.equal((await db!.pool.query('SELECT count(*)::int n FROM service_attachments WHERE visit_id = $1', [s2])).rows[0].n, 0, 'vehicle delete cascades');
});

test('filename sanitisation and Content-Disposition encoding', { skip }, async () => {
  assert.equal(sanitiseFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitiseFileName('C:\\Users\\me\\scan.pdf'), 'scan.pdf');
  assert.equal(sanitiseFileName('a\r\nb\u202e.pdf'), 'ab.pdf');
  assert.equal(sanitiseFileName('..'), null);
  assert.equal(sanitiseFileName('x'.repeat(500))!.length, 200);
  assert.equal(sanitiseFileName(5), null);
  const cd = contentDisposition('attachment', 'a"b\'c;ü☃.pdf');
  assert.ok(!/[\r\n]/.test(cd));
  assert.equal(cd, `attachment; filename="a_b_c___.pdf"; filename*=UTF-8''a%22b%27c%3B%C3%BC%E2%98%83.pdf`);

  const v = await vehicle(), s = await visit(v);
  const names: [string, string][] = [['../../evil.pdf', 'evil.pdf'], ['Quittung für Öl ☃.pdf', 'Quittung für Öl ☃.pdf'], ['q"uote\r\nX-Injected: 1.pdf', 'q"uoteX-Injected: 1.pdf']];
  for (const [given, want] of names) {
    const a = await up(v, s, PDF, given, 'application/pdf');
    assert.equal(a.status, 201); assert.equal(a.json.fileName, want);
    const d = await app.call(owner, 'GET', base(v, s, a.json.id));
    assert.equal(d.headers.get('x-injected'), null);
    assert.ok(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!$&+^`|#-]+$/.test(d.headers.get('content-disposition')!), d.headers.get('content-disposition')!);
  }
  const none = await up(v, s, PNG, null, 'image/png');
  assert.equal(none.json.fileName, 'attachment.png');
});

test('module off: everything 404, but bytes stay in the export; import re-creates them', { skip }, async () => {
  const v = await vehicle(), s = await visit(v);
  const a = await up(v, s, PDF, 'inv.pdf', 'application/pdf');
  await up(v, s, PNG, 'p.png', 'image/png');
  await setModule(db!.pool, 'service', false);
  try {
    assert.equal((await up(v, s, PNG, 'x.png', 'image/png')).status, 404);
    for (const m of ['GET', 'DELETE'] as const) assert.equal((await app.call(owner, m, base(v, s, a.json.id))).status, m === 'GET' ? 404 : 404);
    assert.equal((await app.call(owner, 'PATCH', base(v, s, a.json.id), { fileName: 'z.pdf' })).json.code, 'module_disabled');
    const ex = await app.call(owner, 'GET', `/v1/vehicles/${v}/export?format=json`);
    assert.equal(ex.status, 200);
    const doc = JSON.parse(ex.text);
    const atts = doc.serviceVisits[0].attachments;
    assert.equal(atts.length, 2);
    assert.deepEqual(Object.keys(atts[0]).sort(), ['contentType', 'data', 'fileName', 'sha256']);
    assert.equal(atts[0].sha256, createHash('sha256').update(PDF).digest('hex'));
    assert.ok(Buffer.from(atts[0].data, 'base64').equals(PDF));

    // Import into a new vehicle (module still off) re-creates them, once.
    const imp = await app.call(owner, 'POST', '/v1/vehicle-imports', { data: doc, dryRun: false });
    assert.equal(imp.status, 200, imp.text);
    const nv = imp.json.vehicle.id;
    await setModule(db!.pool, 'service', true);
    const visits = (await app.call(owner, 'GET', `/v1/vehicles/${nv}/service-visits`)).json.items;
    assert.equal(visits[0].attachments.length, 2);
    const d = await app.call(owner, 'GET', base(nv, visits[0].id, visits[0].attachments[0].id));
    assert.ok(d.bytes.equals(PDF));
    // Re-import into the same vehicle: visit is a duplicate, nothing doubles.
    const again = await app.call(owner, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: doc, dryRun: false });
    assert.equal(again.json.serviceVisits.duplicates, 1);
    assert.equal((await app.call(owner, 'GET', `/v1/vehicles/${nv}/service-visits`)).json.items[0].attachments.length, 2);

    // Import validation: bad magic, bad checksum, too many, in-file duplicates.
    const mk = (attachments: unknown) => ({ ...doc, serviceVisits: [{ ...doc.serviceVisits[0], provider: 'Other', attachments }] });
    const tryImport = (attachments: unknown) => app.call(owner, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: mk(attachments), dryRun: true });
    const exe = Buffer.from('MZ not a pdf').toString('base64');
    assert.equal((await tryImport([{ fileName: 'a.pdf', data: exe }])).json.errors[0].code, 'attachment_type');
    assert.equal((await tryImport([{ fileName: 'a.pdf', contentType: 'application/pdf', data: PNG.toString('base64') }])).json.errors[0].code, 'attachment_type');
    assert.equal((await tryImport([{ fileName: 'a.png', sha256: '0'.repeat(64), data: PNG.toString('base64') }])).json.errors[0].code, 'attachment_checksum');
    assert.equal((await tryImport(Array.from({ length: MAX_ATTACHMENTS_PER_VISIT + 1 }, () => ({ fileName: 'a.png', data: PNG.toString('base64') })))).json.errors[0].code, 'attachment_limit');
    const dedup = await app.call(owner, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: mk([{ fileName: 'a.png', data: PNG.toString('base64') }, { fileName: 'b.png', data: PNG.toString('base64') }]), dryRun: false });
    assert.equal(dedup.status, 200, dedup.text);
    const last = (await app.call(owner, 'GET', `/v1/vehicles/${nv}/service-visits`)).json.items.find((x: any) => x.provider === 'Other');
    assert.equal(last.attachments.length, 1, 'duplicate sha256 skipped');
    // Old files without the key stay importable.
    const old = mk(undefined); delete old.serviceVisits[0].attachments; old.serviceVisits[0].provider = 'Older';
    assert.equal((await app.call(owner, 'POST', `/v1/vehicles/${nv}/import`, { format: 'json', data: old, dryRun: false })).status, 200);
  } finally { await setModule(db!.pool, 'service', true); }
});
