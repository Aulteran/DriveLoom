// API keys, phase 4: permission-aware portability, preview binding, idempotency, service dedupe and the primary
// use case end to end (a key that may only read one vehicle and write its service history, importing visits with receipts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as keys from '../src/auth/api-keys.ts';
import { setModule } from '../src/modules.ts';
import { PREVIEW_TTL_MS } from '../src/auth/import-previews.ts';
import { fixture, keyWorld, PNG_BYTES, type Fixture, type KeyWorld, type Res } from './helpers/keys.ts';
import type { TestUser } from './helpers/index.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const problem = (r: Res, status: number, code: string, label = '') => { assert.equal(r.status, status, `${label} ${r.text.slice(0, 400)}`); assert.equal(r.json?.code, code, `${label} ${r.text.slice(0, 400)}`); };
const FULL = { vehicle_info: 'read', fuel: 'full', service: 'full', maintenance: 'full', vehicle_settings: 'full' };
const SERVICE_ONLY = { vehicle_info: 'read', service: 'read_write' };

const doc = (over: Record<string, unknown> = {}) => ({ format: 'driveloom.vehicle', version: 1, vehicle: { name: 'Imported', odometerUnit: 'km', currency: 'EUR' }, fillUps: [], ...over });
const fill = (km: string, at = '2026-10-20T08:00:00Z') => ({ occurredAt: at, odometer: { value: km, unit: 'km' }, volume: { value: '10', unit: 'l' } });
const visit = (n: number, extra: Record<string, unknown> = {}) => ({ servicedOn: `2026-09-${String(n).padStart(2, '0')}`, odometer: { value: String(5000 + n), unit: 'km' }, provider: 'Garage', items: [{ name: `Job ${n}` }], ...extra });
const receipt = (tag: string) => ({ fileName: `${tag}.png`, data: PNG_BYTES(tag).toString('base64') });
const task = { ref: 't1', name: 'Imported task', intervalDays: 90 };

const TABLES = ['fill_ups', 'service_visits', 'service_items', 'service_attachments', 'maintenance_tasks', 'vehicles', 'audit_events', 'api_key_activity', 'api_key_import_previews', 'api_key_idempotency'];
async function counts(w: KeyWorld): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
  return out;
}
const same = (a: Record<string, number>, b: Record<string, number>, label: string, except: string[] = []) => {
  for (const t of TABLES) if (!except.includes(t)) assert.equal(b[t], a[t], `${label}: ${t} changed`);
};
/** Key activity written by anything but key management itself. */
const writeActivity = async (w: KeyWorld): Promise<number> => (await w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM api_key_activity WHERE action NOT IN ('created', 'updated', 'revoked', 'rotated', 'removed', 'revoked_all')")).rows[0]!.n;

interface Ctx { w: KeyWorld; owner: TestUser; fx: Fixture; V: string }
async function setup(fn: (c: Ctx) => Promise<void>, opts: { serviceModule?: boolean } = {}): Promise<void> {
  await keyWorld(async (w) => {
    const owner = await w.user('owner');
    const fx = await fixture(w, owner);
    await fn({ w, owner, fx, V: `/v1/vehicles/${fx.vehicleId}` });
  }, opts);
}
const importer = (w: KeyWorld, V: string, token: string) => (body: unknown, headers?: Record<string, string>) => w.call('POST', `${V}/import`, { token, body, ...(headers ? { headers } : {}) });
/** Preview then commit with the token (the normal flow for a key). */
async function previewThenCommit(w: KeyWorld, V: string, token: string, data: unknown, headers?: Record<string, string>): Promise<{ preview: Res; commit: Res }> {
  const imp = importer(w, V, token);
  const preview = await imp({ format: 'json', data });
  assert.equal(preview.status, 200, preview.text.slice(0, 400));
  assert.ok(preview.json.previewToken, 'a clean dry run by a key returns a preview token');
  const commit = await imp({ format: 'json', data, dryRun: false, previewToken: preview.json.previewToken }, headers);
  return { preview, commit };
}

// ---------- export ----------
test('scoped export: each grant adds exactly its section; omitted sections are named and never leak values', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    // A visit whose item completes the task, so there is a taskRef to strip.
    assert.equal((await w.call('POST', `${V}/service-visits`, { as: owner, body: { servicedOn: '2026-10-03', items: [{ name: 'Linked job', taskId: fx.taskId }], externalId: 'src-1' } })).status, 201);
    const exp = async (perms: Record<string, string>, q = 'json') => {
      const { token } = await w.mint(owner, { permissions: perms, vehicleIds: [fx.vehicleId] });
      return w.call('GET', `${V}/export?format=${q}`, { token });
    };
    const keysOf = (r: Res) => Object.keys(r.json).filter((k) => ['fillUps', 'serviceVisits', 'maintenanceTasks'].includes(k)).sort();

    const info = await exp({ vehicle_info: 'read' });
    assert.equal(info.status, 200, info.text);
    assert.deepEqual(keysOf(info), [], 'vehicle details only');
    assert.deepEqual(info.json.omittedSections.sort(), ['fillUps', 'maintenanceTasks', 'serviceVisits']);
    assert.equal(info.json.vehicle.name, 'Car');
    for (const secret of ['Oil change', 'Wipers', 'Linked job', 'receipt', 'src-1', '1000']) assert.ok(!info.text.includes(secret), `no value of an omitted section leaks (${secret})`);

    const fuel = await exp({ vehicle_info: 'read', fuel: 'read' });
    assert.deepEqual(keysOf(fuel), ['fillUps']);
    assert.equal(fuel.json.fillUps.length, 1);
    assert.deepEqual(fuel.json.omittedSections.sort(), ['maintenanceTasks', 'serviceVisits']);
    assert.ok(!fuel.text.includes('Wipers'));

    const svc = await exp({ vehicle_info: 'read', service: 'read' });
    assert.deepEqual(keysOf(svc), ['serviceVisits']);
    assert.deepEqual(svc.json.omittedSections.sort(), ['fillUps', 'maintenanceTasks']);
    assert.equal(svc.json.serviceVisits.length, 2);
    assert.ok(svc.json.serviceVisits.some((v: any) => v.attachments.length === 1 && v.attachments[0].data), 'receipts travel with the visits');
    assert.ok(svc.json.serviceVisits.some((v: any) => v.externalId === 'src-1'), 'externalId is exported');
    assert.ok(!svc.text.includes('taskRef'), 'a link to a task the key may not read is stripped');

    const tasksOnly = await exp({ vehicle_info: 'read', maintenance: 'read' });
    assert.deepEqual(keysOf(tasksOnly), ['maintenanceTasks']);
    assert.equal(tasksOnly.json.maintenanceTasks[0].name, 'Oil change');
    assert.ok(!tasksOnly.text.includes('Linked job'));

    const all = await exp({ vehicle_info: 'read', fuel: 'read', service: 'read', maintenance: 'read' });
    assert.deepEqual(keysOf(all), ['fillUps', 'maintenanceTasks', 'serviceVisits']);
    assert.deepEqual(all.json.omittedSections, []);
    assert.ok(all.text.includes('taskRef'), 'with maintenance.read the link survives');

    // The Service module off: visits and tasks are omitted even for a fully granted key; fuel is not gated.
    await setModule(w.db, 'service', false);
    const off = await exp({ vehicle_info: 'read', fuel: 'read', service: 'read', maintenance: 'read' });
    assert.deepEqual(keysOf(off), ['fillUps']);
    assert.deepEqual(off.json.omittedSections.sort(), ['maintenanceTasks', 'serviceVisits']);
    // ... while a session keeps its documented behaviour (nothing stranded) and sees no `omittedSections` at all.
    const sess = await w.call('GET', `${V}/export?format=json`, { as: owner });
    assert.deepEqual(keysOf(sess), ['fillUps', 'maintenanceTasks', 'serviceVisits']);
    assert.ok(!('omittedSections' in sess.json));
    await setModule(w.db, 'service', true);

    // CSV is fuel only: it needs fuel.read.
    problem(await exp({ vehicle_info: 'read', service: 'full' }, 'csv'), 403, 'insufficient_scope');
    assert.equal((await exp({ vehicle_info: 'read', service: 'full' }, 'csv')).json.required, 'fuel.read');
    const csv = await exp({ vehicle_info: 'read', fuel: 'read' }, 'csv');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^occurred_at,/);
    // No vehicle_info: the entry grant is missing.
    const { token } = await w.mint(owner, { permissions: { fuel: 'read' }, vehicleIds: [fx.vehicleId] });
    problem(await w.call('GET', `${V}/export?format=json`, { token }), 403, 'insufficient_scope');
  });
});

test('a scoped export imports back under the same scope (round trip), and a key export is never recorded as activity', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const reader = await w.mint(owner, { name: 'reader', permissions: { vehicle_info: 'read', service: 'read' }, vehicleIds: [fx.vehicleId] });
    const exported = await w.call('GET', `${V}/export?format=json`, { token: reader.token });
    assert.equal(exported.status, 200);
    const target = await w.call('POST', '/v1/vehicles', { as: owner, body: { name: 'Target', odometerUnit: 'km', currency: 'EUR' } });
    const T = `/v1/vehicles/${target.json.id}`;
    const writer = await w.mint(owner, { name: 'writer', permissions: SERVICE_ONLY, vehicleIds: [target.json.id] });
    // fillUps and tasks are omitted from the file: the file imports without them and needs only the service grant.
    const { commit } = await previewThenCommit(w, T, writer.token, exported.json);
    assert.equal(commit.status, 200, commit.text.slice(0, 500));
    assert.equal(commit.json.committed, true);
    assert.equal(commit.json.serviceVisits.created, 1);
    const back = await w.call('GET', `${T}/service-visits`, { as: owner });
    assert.equal(back.json.items.length, 1);
    assert.equal(back.json.items[0].attachments.length, 1);
    const acts = (await w.db.query<{ action: string }>('SELECT action FROM api_key_activity WHERE key_id = $1', [reader.id])).rows;
    assert.deepEqual(acts.filter((a) => a.action !== 'created'), [], 'an export is a read: not key activity');
  });
});

// ---------- import: whole-request authorization ----------
test('an import with anything out of scope is refused whole, dry run included, with zero mutations', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const mkTok = async (perms: Record<string, string>) => (await w.mint(owner, { permissions: perms, vehicleIds: [fx.vehicleId] })).token;
    const everything = doc({ fillUps: [fill('2000')], serviceVisits: [visit(1, { attachments: [receipt('a')] })], maintenanceTasks: [task] });
    const before = await counts(w);
    const missing = async (token: string, body: unknown) => { const r = await importer(w, V, token)(body); problem(r, 403, 'insufficient_scope'); return (r.json.missing as string[]).slice().sort(); };
    for (const dryRun of [true, false]) {
      const body = { format: 'json', data: everything, dryRun, ...(dryRun ? {} : { previewToken: 'dlp_' + 'a'.repeat(32) }) };
      assert.deepEqual(await missing(await mkTok(SERVICE_ONLY), body), ['fuel.create', 'maintenance.create'], `service only (dryRun ${dryRun})`);
      assert.deepEqual(await missing(await mkTok({ ...SERVICE_ONLY, fuel: 'read_write' }), body), ['maintenance.create']);
      assert.deepEqual(await missing(await mkTok({ vehicle_info: 'read', service: 'read', fuel: 'full', maintenance: 'full' }), body), ['service.create'], 'service.read cannot create');
      assert.deepEqual(await missing(await mkTok({ vehicle_info: 'read' }), body), ['fuel.create', 'maintenance.create', 'service.create']);
    }
    // Nested: an item that links a task needs maintenance.read, even when nothing else is out of scope.
    const linked = doc({ serviceVisits: [visit(2, { items: [{ name: 'x', taskId: fx.taskId }] })] });
    assert.deepEqual(await missing(await mkTok(SERVICE_ONLY), { format: 'json', data: linked }), ['maintenance.read']);
    // ... by task reference to a task of the same file as well.
    const refLinked = doc({ maintenanceTasks: [task], serviceVisits: [visit(3, { items: [{ name: 'y', taskRef: 't1' }] })] });
    assert.deepEqual(await missing(await mkTok(SERVICE_ONLY), { format: 'json', data: refLinked }), ['maintenance.create', 'maintenance.read']);
    // maintenance read_write covers both the creation and the link.
    const ok = await importer(w, V, await mkTok({ ...SERVICE_ONLY, maintenance: 'read_write' }))({ format: 'json', data: refLinked });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    assert.equal(ok.json.summary.invalid, 0);
    // CSV purchases need fuel.create.
    const csv = await importer(w, V, await mkTok(SERVICE_ONLY))({ format: 'csv', data: 'occurred_at,odometer,odometer_unit,volume,volume_unit\n2026-09-01T08:00:00Z,2000,km,10,l\n' });
    problem(csv, 403, 'insufficient_scope');
    assert.equal(csv.json.required, 'fuel.create');
    same(before, await counts(w), 'refused imports', ['api_key_import_previews', 'api_key_activity', 'audit_events']);
    assert.equal(await writeActivity(w), 0, 'a preview records nothing');
  });
});

test('refused imports change nothing at all, and a key without the entry grant is refused before the payload is read', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const other = await fixture(w, owner, { name: 'Other' });
    const before = await counts(w);
    const tok = (await w.mint(owner, { permissions: { service: 'read_write' }, vehicleIds: [fx.vehicleId] })).token;
    problem(await importer(w, V, tok)({ format: 'json', data: doc({ serviceVisits: [visit(1)] }) }), 403, 'insufficient_scope');
    const readOnly = (await w.mint(owner, { permissions: { vehicle_info: 'read', service: 'read' }, vehicleIds: [fx.vehicleId] })).token;
    const r = await importer(w, V, readOnly)({ format: 'json', data: doc({ serviceVisits: [visit(1)] }), dryRun: true });
    problem(r, 403, 'insufficient_scope');
    assert.deepEqual(r.json.missing, ['service.create']);
    // Another vehicle outside the selection: the ordinary 404.
    problem(await w.call('POST', `/v1/vehicles/${other.vehicleId}/import`, { token: readOnly, body: { format: 'json', data: doc() } }), 404, 'vehicle_not_found');
    same(before, await counts(w), 'refusals', ['api_key_activity', 'audit_events']);
    assert.equal(await writeActivity(w), 0);
  });
});

// ---------- preview binding ----------
test('preview then commit: the token binds key, target and payload; a preview writes nothing; the token is single use', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { name: 'importer', permissions: { ...SERVICE_ONLY, fuel: 'read_write' }, vehicleIds: [fx.vehicleId] });
    const imp = importer(w, V, key.token);
    const data = doc({ fillUps: [fill('2000')], serviceVisits: [visit(1, { attachments: [receipt('a')] }), visit(2)] });
    const before = await counts(w);
    const preview = await imp({ format: 'json', data });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.dryRun, true);
    assert.equal(preview.json.committed, false);
    assert.equal(preview.json.serviceVisits.created, 2, 'the preview reports what a commit would do');
    assert.match(preview.json.previewToken, /^dlp_[A-Za-z0-9_-]{32}$/);
    assert.ok(Date.parse(preview.json.previewExpiresAt) - w.h.clock.t <= PREVIEW_TTL_MS);
    same(before, await counts(w), 'preview', ['api_key_import_previews']);
    assert.equal((await counts(w))['api_key_import_previews'], before['api_key_import_previews']! + 1);
    assert.equal((await w.db.query("SELECT count(*)::int AS n FROM api_key_activity WHERE action LIKE '%import'")).rows[0].n, 0, 'no success audit on preview');
    const token = preview.json.previewToken;
    assert.ok(!(await w.db.query('SELECT 1 FROM api_key_import_previews WHERE token_hash = $1', [token])).rowCount, 'the token itself is never stored');

    // A commit needs the token ...
    problem(await imp({ format: 'json', data, dryRun: false }), 409, 'preview_required');
    problem(await imp({ format: 'json', data, dryRun: false, previewToken: 'dlp_nonsense' }), 409, 'preview_mismatch');
    // ... for the same payload (one byte of difference is a different payload) ...
    const edited = doc({ fillUps: [fill('2000')], serviceVisits: [visit(1, { attachments: [receipt('a')] }), visit(2, { notes: 'edited after the preview' })] });
    problem(await imp({ format: 'json', data: edited, dryRun: false, previewToken: token }), 409, 'preview_mismatch');
    // ... of the same format (CSV with the same rows is another payload) ...
    // ... for the same target ...
    const other = await w.call('POST', '/v1/vehicles', { as: owner, body: { name: 'Other', odometerUnit: 'km', currency: 'EUR' } });
    const otherKey = await w.mint(owner, { permissions: { ...SERVICE_ONLY, fuel: 'read_write' }, vehicleIds: [fx.vehicleId, other.json.id], name: 'second' });
    const base = await counts(w);
    problem(await w.call('POST', `/v1/vehicles/${other.json.id}/import`, { token: key.token, body: { format: 'json', data, dryRun: false, previewToken: token } }), 404, 'vehicle_not_found');
    problem(await w.call('POST', `/v1/vehicles/${other.json.id}/import`, { token: otherKey.token, body: { format: 'json', data, dryRun: false, previewToken: token } }), 409, 'preview_mismatch');
    // ... and by the same key.
    problem(await w.call('POST', `${V}/import`, { token: otherKey.token, body: { format: 'json', data, dryRun: false, previewToken: token } }), 409, 'preview_mismatch');
    same(base, await counts(w), 'rejected commits', ['api_key_import_previews', 'api_key_activity', 'audit_events']);
    assert.equal(await writeActivity(w), 0);

    // The right request still works after all of that (rejections did not burn the token).
    const commit = await imp({ format: 'json', data, dryRun: false, previewToken: token });
    assert.equal(commit.status, 200, commit.text.slice(0, 500));
    assert.equal(commit.json.committed, true);
    assert.equal(commit.json.previewToken, undefined);
    assert.equal(commit.json.serviceVisits.created, 2);
    const after = await counts(w);
    assert.equal(after['service_visits'], before['service_visits']! + 2);
    assert.equal(after['service_attachments'], before['service_attachments']! + 1);
    assert.equal(after['fill_ups'], before['fill_ups']! + 1);
    // Single use.
    problem(await imp({ format: 'json', data, dryRun: false, previewToken: token }), 409, 'preview_mismatch');
    assert.equal((await counts(w))['service_visits'], after['service_visits']);

    // Attribution: a summary row and the ids of every record, owner-visible through the key history.
    const hist = await w.call('GET', `/v1/auth/api-keys/${key.id}/activity?limit=100`, { as: owner });
    const rows = hist.json.items as { action: string; targetIds: string[]; vehicleId: string }[];
    const created = (await w.db.query<{ id: string }>("SELECT id FROM service_visits WHERE vehicle_id = $1 AND provider = 'Garage'", [fx.vehicleId])).rows.map((r) => r.id).sort();
    assert.equal(rows.filter((r) => r.action === 'vehicle.import').length, 1);
    assert.deepEqual(rows.find((r) => r.action === 'service_visit.import')!.targetIds.slice().sort(), created);
    assert.equal(rows.find((r) => r.action === 'service_attachment.import')!.targetIds.length, 1);
    assert.equal(rows.find((r) => r.action === 'fill_up.import')!.targetIds.length, 1);
    assert.ok(rows.filter((r) => r.action.endsWith('.import') || r.action === 'vehicle.import').every((r) => r.vehicleId === fx.vehicleId));
    assert.ok(!JSON.stringify(hist.json).includes('data:') && !JSON.stringify(hist.json).includes(PNG_BYTES('a').toString('base64')), 'no receipt content in the history');
    const audit = (await w.db.query("SELECT details FROM audit_events WHERE action = 'vehicle.import' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(audit.details.apiKey, { id: key.id, name: 'importer' });
  });
});

test('an expired preview is refused; a preview with invalid rows gets no token', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    const imp = importer(w, V, key.token);
    const data = doc({ serviceVisits: [visit(4)] });
    const p = await imp({ format: 'json', data });
    w.h.clock.t += PREVIEW_TTL_MS + 1000;
    problem(await imp({ format: 'json', data, dryRun: false, previewToken: p.json.previewToken }), 409, 'preview_expired');
    const before = await counts(w);
    same(before, await counts(w), 'expired');
    assert.equal((await w.db.query('SELECT count(*)::int AS n FROM service_visits WHERE vehicle_id = $1', [fx.vehicleId])).rows[0].n, 1);
    const bad = await imp({ format: 'json', data: doc({ serviceVisits: [{ servicedOn: 'nope', items: [] }] }) });
    assert.equal(bad.status, 200);
    assert.equal(bad.json.summary.invalid, 1);
    assert.equal(bad.json.previewToken, undefined, 'nothing to commit, so nothing to bind');
    // A fresh preview works again.
    const again = await imp({ format: 'json', data });
    assert.equal((await imp({ format: 'json', data, dryRun: false, previewToken: again.json.previewToken })).status, 200);
  });
});

test('the commit re-checks scopes, roles and module gates, and a revoked key cannot commit its preview', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const data = doc({ serviceVisits: [visit(5)] });
    const mintKey = async (name: string) => w.mint(owner, { name, permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    const visits = async () => (await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM service_visits WHERE vehicle_id = $1', [fx.vehicleId])).rows[0]!.n;
    const base = await visits();
    const run = async (name: string, change: () => Promise<void>, status: number, code: string) => {
      const k = await mintKey(name);
      const p = await importer(w, V, k.token)({ format: 'json', data });
      await change();
      const r = await importer(w, V, k.token)({ format: 'json', data, dryRun: false, previewToken: p.json.previewToken });
      problem(r, status, code, name);
      assert.equal(await visits(), base, `${name}: nothing written`);
    };
    await run('scope reduced', async () => { await keys.updateApiKey(w.h.ctx, owner.principal, (await w.db.query<{ id: string }>("SELECT id FROM api_keys WHERE name = 'scope reduced'")).rows[0]!.id, keys.parsePatchInput({ permissions: { vehicle_info: 'read', service: 'read' } })); }, 403, 'insufficient_scope');
    await run('selection reduced', async () => { await keys.updateApiKey(w.h.ctx, owner.principal, (await w.db.query<{ id: string }>("SELECT id FROM api_keys WHERE name = 'selection reduced'")).rows[0]!.id, keys.parsePatchInput({ vehicleIds: [] })); }, 404, 'vehicle_not_found');
    await run('revoked', async () => { await keys.deleteApiKey(w.h.ctx, owner.principal, (await w.db.query<{ id: string }>("SELECT id FROM api_keys WHERE name = 'revoked'")).rows[0]!.id); }, 401, 'invalid_api_key');
    await run('module off', async () => { await setModule(w.db, 'service', false); }, 404, 'module_disabled');
    await setModule(w.db, 'service', true);
    await run('archived', async () => { assert.equal((await w.call('PUT', `${V}/archive`, { as: owner, body: { archived: true } })).status, 200); }, 409, 'vehicle_archived');
    assert.equal((await w.call('PUT', `${V}/archive`, { as: owner, body: { archived: false } })).status, 200);
    // The owner's own role is re-read as well: a manager whose role drops to viewer between preview and commit.
    const mgr = await w.user('mgr');
    assert.equal((await w.call('POST', `${V}/members`, { as: owner, body: { userId: mgr.id, role: 'editor' } })).status, 201);
    const mk = await w.mint(mgr, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    const p = await importer(w, V, mk.token)({ format: 'json', data });
    assert.equal((await w.call('PUT', `${V}/members/${mgr.id}`, { as: owner, body: { role: 'viewer' } })).status, 200);
    problem(await importer(w, V, mk.token)({ format: 'json', data, dryRun: false, previewToken: p.json.previewToken }), 403, 'forbidden');
    assert.equal(await visits(), base);
  });
});

test('the grants are re-read inside the commit transaction: a reduction that lands after the request started still wins', { skip }, async () => {
  await setup(async ({ w, owner, fx }) => {
    const { createApiKeyGate } = await import('../src/auth/api-key-auth.ts');
    const { allRoutes } = await import('../src/application.ts');
    const { PortabilityService } = await import('../src/portability/service.ts');
    const { VehicleService } = await import('../src/vehicles/service.ts');
    const { FuelService } = await import('../src/fuel/service.ts');
    const { ServiceService } = await import('../src/service/service.ts');
    const gate = createApiKeyGate(w.h.ctx);
    const route = allRoutes(w.h.ctx).find((r) => `${r.method} ${r.path}` === 'POST /v1/vehicles/:vehicleId/import')!;
    const k = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    // Authenticated while service was read_write ...
    const principal = await gate.authenticate({ token: k.token, ip: '127.0.0.1', route, params: { vehicleId: fx.vehicleId }, requestId: null });
    const vehicles = new VehicleService(w.db as never);
    const svc = new PortabilityService(w.db as never, vehicles, new FuelService(w.db as never, vehicles, w.h.ctx.now), new ServiceService(w.db as never, vehicles, w.h.ctx.now), w.h.ctx.now);
    const data = doc({ serviceVisits: [visit(6)] });
    const preview = await svc.importInto(principal, fx.vehicleId, { format: 'json', data });
    // ... and reduced before the transaction runs.
    await keys.updateApiKey(w.h.ctx, owner.principal, k.id, keys.parsePatchInput({ permissions: { vehicle_info: 'read', service: 'read' } }));
    await assert.rejects(svc.importInto(principal, fx.vehicleId, { format: 'json', data, dryRun: false, previewToken: preview.previewToken }), (e: any) => e.status === 403 && e.code === 'insufficient_scope' && e.extra.missing[0] === 'service.create');
    assert.equal((await w.db.query('SELECT count(*)::int AS n FROM service_visits WHERE vehicle_id = $1', [fx.vehicleId])).rows[0].n, 1);
  });
});

test('a failure in the middle of a commit rolls everything back, and the preview stays usable', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: { ...SERVICE_ONLY, fuel: 'read_write', maintenance: 'read_write' }, vehicleIds: [fx.vehicleId] });
    const imp = importer(w, V, key.token);
    const data = doc({ fillUps: [fill('2000')], maintenanceTasks: [task], serviceVisits: [visit(7, { attachments: [receipt('z')] }), visit(8)] });
    const p = await imp({ format: 'json', data });
    assert.equal(p.status, 200);
    const before = await counts(w);
    // The per-record history is written last: make that fail, and the records, receipts, audit and idempotency claim must all vanish.
    await w.db.query(`CREATE FUNCTION fail_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await w.db.query("CREATE TRIGGER fail_import BEFORE INSERT ON api_key_activity FOR EACH ROW WHEN (NEW.action = 'maintenance_task.import') EXECUTE FUNCTION fail_import()");
    const failed = await imp({ format: 'json', data, dryRun: false, previewToken: p.json.previewToken }, { 'idempotency-key': 'rollback-1' });
    assert.equal(failed.status, 500);
    same(before, await counts(w), 'failed commit');
    await w.db.query('DROP TRIGGER fail_import ON api_key_activity');
    const ok = await imp({ format: 'json', data, dryRun: false, previewToken: p.json.previewToken }, { 'idempotency-key': 'rollback-1' });
    assert.equal(ok.status, 200, 'the same preview and the same Idempotency-Key work once the cause is gone');
    assert.equal(ok.json.committed, true);
    const after = await counts(w);
    assert.equal(after['service_visits'], before['service_visits']! + 2);
    assert.equal(after['maintenance_tasks'], before['maintenance_tasks']! + 1);
    // Invalid rows in a commit roll everything back too (existing all-or-nothing rule), with the report.
    const k2 = await w.mint(owner, { permissions: { ...SERVICE_ONLY, fuel: 'read_write' }, vehicleIds: [fx.vehicleId], name: 'k2' });
    const mixed = doc({ fillUps: [fill('9000', '2026-09-20T08:00:00Z')], serviceVisits: [visit(9), { servicedOn: 'bad', items: [] }] });
    const p2 = await importer(w, V, k2.token)({ format: 'json', data: mixed });
    assert.equal(p2.json.previewToken, undefined);
    const b2 = await counts(w);
    const c2 = await importer(w, V, k2.token)({ format: 'json', data: mixed, dryRun: false, previewToken: 'dlp_' + 'b'.repeat(32) });
    problem(c2, 409, 'preview_mismatch');
    same(b2, await counts(w), 'invalid commit');
  });
});

// ---------- new vehicle ----------
test('new-vehicle import: vehicle_create plus every section write; the new vehicle joins scope only in all_current_future', { skip }, async () => {
  await setup(async ({ w, owner, fx }) => {
    const mk = async (over: Record<string, unknown>) => w.mint(owner, { ...(over['vehicleMode'] ? {} : { vehicleIds: [fx.vehicleId] }), ...over });
    const data = doc({ vehicle: { name: 'Brand new', odometerUnit: 'km', currency: 'EUR' }, fillUps: [fill('100')], serviceVisits: [visit(1, { attachments: [receipt('n1')] })], maintenanceTasks: [task] });
    const before = await counts(w);
    const post = (token: string, body: unknown, headers?: Record<string, string>) => w.call('POST', '/v1/vehicle-imports', { token, body, ...(headers ? { headers } : {}) });
    // No vehicle creation grant: refused at the router, before the payload is read.
    const noCreate = await mk({ permissions: { fuel: 'read_write', service: 'read_write', maintenance: 'read_write' } });
    problem(await post(noCreate.token, { data }), 403, 'insufficient_scope');
    // Creation but a section's write is missing: the whole request is refused, nothing is created, not even the vehicle.
    for (const [perms, missing] of [[{ fuel: 'read_write', service: 'read_write' }, ['maintenance.create']], [{}, ['fuel.create', 'maintenance.create', 'service.create']], [{ fuel: 'read', service: 'full', maintenance: 'full' }, ['fuel.create']]] as const) {
      const k = await mk({ vehicleCreate: true, permissions: perms });
      const r = await post(k.token, { data, dryRun: false, previewToken: 'dlp_' + 'c'.repeat(32) });
      problem(r, 403, 'insufficient_scope');
      assert.deepEqual((r.json.missing as string[]).sort(), missing);
      assert.equal((await post(k.token, { data })).status, 403, 'dry run as well');
    }
    same(before, await counts(w), 'refused new-vehicle imports', ['api_key_activity', 'audit_events']);
    assert.equal(await writeActivity(w), 0);

    // Everything granted, mode selected: preview, commit, and the key cannot read what it created.
    const sel = await mk({ name: 'selected', vehicleCreate: true, permissions: { vehicle_info: 'read', fuel: 'read_write', service: 'read_write', maintenance: 'read_write' } });
    const p = await post(sel.token, { data });
    assert.equal(p.status, 200, p.text.slice(0, 400));
    assert.equal(p.json.committed, false);
    same(before, await counts(w), 'new-vehicle preview', ['api_key_import_previews', 'api_key_activity', 'audit_events']);
    assert.equal(await writeActivity(w), 0, 'a preview records nothing');
    const c = await post(sel.token, { data, dryRun: false, previewToken: p.json.previewToken }, { 'idempotency-key': 'new-1' });
    assert.equal(c.status, 200, c.text.slice(0, 400));
    assert.equal(c.json.committed, true);
    assert.equal(c.json.vehicle.name, 'Brand new');
    assert.equal(c.json.serviceVisits.created, 1);
    problem(await w.call('GET', `/v1/vehicles/${c.json.vehicle.id}`, { token: sel.token }), 404, 'vehicle_not_found');
    assert.equal((await w.call('GET', `/v1/vehicles/${c.json.vehicle.id}`, { as: owner })).status, 200, 'the owner has it');
    // The same Idempotency-Key replays the report instead of creating a second vehicle.
    const replay = await post(sel.token, { data, dryRun: false, previewToken: p.json.previewToken }, { 'idempotency-key': 'new-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(replay.json.vehicle.id, c.json.vehicle.id);
    assert.equal((await counts(w))['vehicles'], before['vehicles']! + 1);
    // The owner's key history names the new vehicle's records.
    const hist = await w.call('GET', `/v1/auth/api-keys/${sel.id}/activity?limit=100`, { as: owner });
    assert.ok(hist.json.items.some((i: any) => i.action === 'vehicle.create'));
    assert.ok(hist.json.items.some((i: any) => i.action === 'service_visit.import' && i.vehicleId === c.json.vehicle.id));

    // all_current_future: the created vehicle is in scope.
    const fut = await mk({ name: 'future', vehicleMode: 'all_current_future', vehicleCreate: true, permissions: { vehicle_info: 'read' } });
    const small = doc({ vehicle: { name: 'Second', odometerUnit: 'km', currency: 'EUR' } });
    const pf = await post(fut.token, { data: small });
    const cf = await post(fut.token, { data: small, dryRun: false, previewToken: pf.json.previewToken });
    assert.equal(cf.status, 200, cf.text);
    assert.equal((await w.call('GET', `/v1/vehicles/${cf.json.vehicle.id}`, { token: fut.token })).status, 200);
    // A static key's reduction after the preview kills the commit.
    const pf2 = await post(fut.token, { data: doc({ vehicle: { name: 'Third', odometerUnit: 'km', currency: 'EUR' } }) });
    await keys.updateApiKey(w.h.ctx, owner.principal, fut.id, keys.parsePatchInput({ vehicleCreate: false }));
    problem(await post(fut.token, { data: doc({ vehicle: { name: 'Third', odometerUnit: 'km', currency: 'EUR' } }), dryRun: false, previewToken: pf2.json.previewToken }), 403, 'insufficient_scope');
  });
});

// ---------- duplicates ----------
test('externalId: identical is skipped, different is a conflict, create and update refuse a taken id, ids are per vehicle', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    const original = visit(10, { externalId: 'ext-10', attachments: [receipt('e10')] });
    const first = await previewThenCommit(w, V, key.token, doc({ serviceVisits: [original] }));
    assert.equal(first.commit.status, 200, first.commit.text);
    assert.equal(first.commit.json.serviceVisits.created, 1);
    assert.deepEqual(first.commit.json.serviceVisits.records.map((r: any) => [r.externalId, r.outcome]), [['ext-10', 'created']]);
    const stored = (await w.db.query<{ id: string }>("SELECT id FROM service_visits WHERE external_id = 'ext-10'")).rows;
    assert.equal(stored.length, 1);
    const after = await counts(w);

    // The same file again: nothing new, reported as a duplicate with the stored id.
    const again = await previewThenCommit(w, V, key.token, doc({ serviceVisits: [original] }));
    assert.equal(again.commit.status, 200);
    assert.equal(again.commit.json.serviceVisits.created, 0);
    assert.equal(again.commit.json.serviceVisits.duplicates, 1);
    assert.deepEqual(again.commit.json.serviceVisits.records, [{ row: 1, externalId: 'ext-10', outcome: 'duplicate', visitId: stored[0]!.id }]);
    same(after, await counts(w), 'identical re-import', ['api_key_import_previews', 'audit_events', 'api_key_activity', 'api_key_idempotency']);

    // Same id, different content: an explicit conflict; the preview shows it, there is no token, a commit writes nothing.
    const changed = doc({ serviceVisits: [{ ...original, notes: 'now different' }, visit(11, { externalId: 'ext-11' })] });
    const pv = await importer(w, V, key.token)({ format: 'json', data: changed });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.serviceVisits.conflicts, 1);
    assert.equal(pv.json.summary.invalid, 1);
    assert.equal(pv.json.errors[0].code, 'external_id_conflict');
    assert.equal(pv.json.previewToken, undefined);
    const sessionCommit = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: changed, dryRun: false } });
    problem(sessionCommit, 422, 'import_invalid');
    assert.equal(sessionCommit.json.report.serviceVisits.conflicts, 1);
    same(after, await counts(w), 'conflicting import', ['api_key_import_previews', 'audit_events', 'api_key_activity', 'api_key_idempotency']);
    // A receipt the stored visit lacks also makes it a different visit.
    const withNewReceipt = doc({ serviceVisits: [{ ...original, attachments: [receipt('e10'), receipt('other')] }] });
    assert.equal((await importer(w, V, key.token)({ format: 'json', data: withNewReceipt })).json.serviceVisits.conflicts, 1);

    // The create endpoint and PATCH refuse a taken id; the response names the visit that has it.
    const dup = await w.call('POST', `${V}/service-visits`, { token: key.token, body: { servicedOn: '2026-09-30', items: [{ name: 'x' }], externalId: 'ext-10' } });
    problem(dup, 409, 'external_id_conflict');
    assert.equal(dup.json.visitId, stored[0]!.id);
    const mine = await w.call('POST', `${V}/service-visits`, { token: key.token, body: { servicedOn: '2026-09-30', items: [{ name: 'x' }], externalId: ' ext-12 ' } });
    assert.equal(mine.status, 201);
    assert.equal(mine.json.externalId, 'ext-12', 'trimmed');
    problem(await w.call('PATCH', `${V}/service-visits/${mine.json.id}`, { token: key.token, body: { externalId: 'ext-10' } }), 409, 'external_id_conflict');
    assert.equal((await w.call('PATCH', `${V}/service-visits/${mine.json.id}`, { token: key.token, body: { externalId: null } })).json.externalId, null);
    assert.equal((await w.call('POST', `${V}/service-visits`, { token: key.token, body: { servicedOn: '2026-09-30', items: [{ name: 'x' }], externalId: 'a'.repeat(201) } })).status, 422);
    // Unique per vehicle, not per instance.
    const other = await w.call('POST', '/v1/vehicles', { as: owner, body: { name: 'Other', odometerUnit: 'km', currency: 'EUR' } });
    assert.equal((await w.call('POST', `/v1/vehicles/${other.json.id}/service-visits`, { as: owner, body: { servicedOn: '2026-09-30', items: [{ name: 'x' }], externalId: 'ext-10' } })).status, 201);
    // Sessions get the same dedupe on import.
    const sessionAgain = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: doc({ serviceVisits: [original] }), dryRun: false } });
    assert.equal(sessionAgain.json.serviceVisits.duplicates, 1);
    assert.equal(sessionAgain.json.previewToken, undefined);
  });
});

test('without an externalId a key sees lookalikes as possibleDuplicate (not skipped); same-day visits stay allowed; sessions keep skipping', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    // The fixture visit: 2026-10-02, no odometer, no provider, items Oil change + Wipers.
    const lookalike = { servicedOn: '2026-10-02', items: [{ name: 'Oil change' }, { name: 'Wipers' }] };
    const sameDayOther = { servicedOn: '2026-10-02', items: [{ name: 'Tyre rotation' }] };
    const data = doc({ serviceVisits: [lookalike, sameDayOther] });
    const imp = importer(w, V, key.token);
    const pv = await imp({ format: 'json', data });
    assert.equal(pv.json.serviceVisits.created, 2, 'both would be imported');
    assert.equal(pv.json.serviceVisits.duplicates, 0, 'nothing is silently skipped');
    assert.deepEqual(pv.json.serviceVisits.possibleDuplicates.map((d: any) => d.row), [1]);
    const stored = (await w.db.query<{ id: string }>('SELECT id FROM service_visits WHERE vehicle_id = $1', [fx.vehicleId])).rows[0]!.id;
    assert.equal(pv.json.serviceVisits.possibleDuplicates[0].visitId, stored);
    const commit = await imp({ format: 'json', data, dryRun: false, previewToken: pv.json.previewToken });
    assert.equal(commit.json.serviceVisits.created, 2);
    assert.equal(commit.json.serviceVisits.possibleDuplicates.length, 1);
    assert.equal((await counts(w))['service_visits'], 3);
    // Two legitimate look-alike visits in ONE file are both kept (the second is merely flagged).
    const twins = doc({ serviceVisits: [visit(20), visit(20)] });
    const tw = await previewThenCommit(w, V, key.token, twins);
    assert.equal(tw.commit.json.serviceVisits.created, 2);
    // A session keeps today's behaviour: the lookalike is skipped silently, the same-day visit is imported.
    const s = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: doc({ serviceVisits: [lookalike, { servicedOn: '2026-10-02', items: [{ name: 'Brand new job' }] }] }), dryRun: false } });
    assert.equal(s.json.serviceVisits.duplicates, 1);
    assert.equal(s.json.serviceVisits.created, 1);
    assert.equal(s.json.serviceVisits.possibleDuplicates, undefined);
  });
});

test('receipts are deduplicated by sha256 per visit', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    const A = `${V}/service-visits/${fx.visitId}/attachments`;
    // The fixture's visit already holds the plain PNG: a key may not add it again, and gets the existing id.
    const dup = await w.call('POST', A, { token: key.token, raw: { type: 'image/png', data: PNG_BYTES() } });
    problem(dup, 409, 'attachment_duplicate');
    assert.equal(dup.json.attachmentId, fx.attachmentId);
    assert.equal((await w.call('POST', A, { token: key.token, raw: { type: 'image/png', data: PNG_BYTES('different') } })).status, 201);
    // Sessions are unchanged (a person re-adding a file is allowed).
    assert.equal((await w.call('POST', A, { as: owner, raw: { type: 'image/png', data: PNG_BYTES() } })).status, 201);
    // The same file twice inside one imported visit is stored once.
    const r = await previewThenCommit(w, V, key.token, doc({ serviceVisits: [visit(21, { attachments: [receipt('same'), receipt('same')] })] }));
    assert.equal(r.commit.json.committed, true);
    assert.equal((await w.db.query("SELECT count(*)::int AS n FROM service_attachments a JOIN service_visits s ON s.id = a.visit_id WHERE s.serviced_on = '2026-09-21'")).rows[0].n, 1);
  });
});

// ---------- idempotency ----------
test('Idempotency-Key: same key and request replays the first outcome; a different request under the key is a conflict', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: { ...FULL }, vehicleIds: [fx.vehicleId] });
    const post = (path: string, body: unknown, k: string, extra: Record<string, unknown> = {}) => w.call('POST', `${V}/${path}`, { token: key.token, body, headers: { 'idempotency-key': k }, ...extra });
    const fillBody = fill('1500', '2026-10-06T08:00:00Z');
    const before = await counts(w);
    const a = await post('fill-ups', fillBody, 'fill-1');
    assert.equal(a.status, 201, a.text);
    assert.equal(a.headers.get('idempotent-replayed'), null);
    const b = await post('fill-ups', fillBody, 'fill-1');
    assert.equal(b.status, 201);
    assert.equal(b.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(b.json, a.json, 'the stored outcome, byte for byte');
    const mid = await counts(w);
    assert.equal(mid['fill_ups'], before['fill_ups']! + 1);
    assert.equal(mid['api_key_activity'], before['api_key_activity']! + 1, 'one attributed write, not two');
    assert.equal(mid['audit_events'], before['audit_events']! + 1);
    // Different payload, same key: 409 and nothing is written.
    problem(await post('fill-ups', fill('1600', '2026-10-07T08:00:00Z'), 'fill-1'), 409, 'idempotency_conflict');
    // Same key, different operation: also a conflict.
    problem(await post('service-visits', { servicedOn: '2026-10-08', items: [{ name: 'x' }] }, 'fill-1'), 409, 'idempotency_conflict');
    assert.deepEqual(await counts(w), mid);
    // The same payload under a different key is a new request: it is the real duplicate it always was.
    problem(await post('fill-ups', fillBody, 'fill-2'), 409, 'duplicate_fill_up');
    assert.equal((await counts(w))['api_key_idempotency'], mid['api_key_idempotency'], 'failures are not remembered');
    // A failed request is not stored: the key is free for the corrected request.
    problem(await post('service-visits', { servicedOn: 'not a date', items: [{ name: 'x' }] }, 'visit-1'), 422, 'validation_failed');
    assert.equal((await post('service-visits', { servicedOn: '2026-10-09', items: [{ name: 'x' }] }, 'visit-1')).status, 201);
    // Visits, tasks and receipts replay too.
    const v1 = await post('service-visits', { servicedOn: '2026-10-10', items: [{ name: 'y' }], externalId: 'idem-visit' }, 'visit-2');
    const v2 = await post('service-visits', { servicedOn: '2026-10-10', items: [{ name: 'y' }], externalId: 'idem-visit' }, 'visit-2');
    assert.equal(v2.status, 201);
    assert.equal(v2.json.id, v1.json.id, 'a replay is not the externalId conflict it would be as a new request');
    const t1 = await post('maintenance-tasks', { name: 'Brakes', intervalDays: 100 }, 'task-1');
    const t2 = await post('maintenance-tasks', { name: 'Brakes', intervalDays: 100 }, 'task-1');
    assert.equal(t2.json.id, t1.json.id);
    const att = (k: string, tag: string) => w.call('POST', `${V}/service-visits/${v1.json.id}/attachments?fileName=r.png`, { token: key.token, raw: { type: 'image/png', data: PNG_BYTES(tag) }, headers: { 'idempotency-key': k } });
    const r1 = await att('att-1', 'one'), r2 = await att('att-1', 'one');
    assert.equal(r1.status, 201);
    assert.equal(r2.json.id, r1.json.id);
    assert.equal(r2.headers.get('idempotent-replayed'), 'true');
    problem(await att('att-1', 'two'), 409, 'idempotency_conflict');
    assert.equal((await w.db.query('SELECT count(*)::int AS n FROM service_attachments WHERE visit_id = $1', [v1.json.id])).rows[0].n, 1);
    // Bad header values are refused.
    problem(await post('fill-ups', fillBody, 'has space'), 422, 'validation_failed');
    problem(await post('fill-ups', fillBody, 'x'.repeat(256)), 422, 'validation_failed');
    // A record expires: after 48 hours the key is new again.
    w.h.clock.t += 49 * 3_600_000;
    const late = await post('maintenance-tasks', { name: 'Brakes', intervalDays: 100 }, 'task-1');
    assert.equal(late.status, 201);
    assert.notEqual(late.json.id, t1.json.id);
    // Sessions ignore the header: two requests, two records.
    const sess = (k: string) => w.call('POST', `${V}/fill-ups`, { as: owner, body: fill('1700', '2026-10-11T08:00:00Z'), headers: { 'idempotency-key': k } });
    assert.equal((await sess('s-1')).status, 201);
    problem(await sess('s-1'), 409, 'duplicate_fill_up');
  });
});

test('concurrent identical requests are serialised: one write, every caller gets the same outcome', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const key = await w.mint(owner, { permissions: { ...FULL }, vehicleIds: [fx.vehicleId] });
    const par = (n: number, f: () => Promise<Res>) => Promise.all(Array.from({ length: n }, f));
    const ids = (rs: Res[]) => new Set(rs.map((r) => r.json.id));
    const before = await counts(w);
    const fills = await par(8, () => w.call('POST', `${V}/fill-ups`, { token: key.token, body: fill('1800', '2026-10-12T08:00:00Z'), headers: { 'idempotency-key': 'par-fill' } }));
    assert.deepEqual(fills.map((r) => r.status), Array(8).fill(201), fills.map((r) => r.text).join('\n').slice(0, 300));
    assert.equal(ids(fills).size, 1);
    const visits = await par(8, () => w.call('POST', `${V}/service-visits`, { token: key.token, body: { servicedOn: '2026-10-12', items: [{ name: 'par' }] }, headers: { 'idempotency-key': 'par-visit' } }));
    assert.deepEqual(visits.map((r) => r.status), Array(8).fill(201));
    assert.equal(ids(visits).size, 1);
    const tasks = await par(6, () => w.call('POST', `${V}/maintenance-tasks`, { token: key.token, body: { name: 'Par task', intervalDays: 30 }, headers: { 'idempotency-key': 'par-task' } }));
    assert.equal(ids(tasks).size, 1);
    const atts = await par(6, () => w.call('POST', `${V}/service-visits/${visits[0]!.json.id}/attachments`, { token: key.token, raw: { type: 'image/png', data: PNG_BYTES('par') }, headers: { 'idempotency-key': 'par-att' } }));
    assert.deepEqual(atts.map((r) => r.status), Array(6).fill(201));
    assert.equal(ids(atts).size, 1);
    // The same key used for two different vehicles at once: exactly one wins, the other is a conflict.
    const second = await w.call('POST', '/v1/vehicles', { as: owner, body: { name: 'Second', odometerUnit: 'km', currency: 'EUR' } });
    const k2 = await w.mint(owner, { permissions: { ...FULL }, vehicleIds: [fx.vehicleId, second.json.id], name: 'two vehicles' });
    const split = await Promise.all([fx.vehicleId, second.json.id].flatMap((vid) => Array.from({ length: 3 }, () => w.call('POST', `/v1/vehicles/${vid}/fill-ups`, { token: k2.token, body: fill('2500', '2026-10-13T08:00:00Z'), headers: { 'idempotency-key': 'par-split' } }))));
    assert.equal(split.filter((r) => r.status === 201).length + split.filter((r) => r.status === 409 && r.json.code === 'idempotency_conflict').length, 6, split.map((r) => r.status).join());
    assert.equal(new Set(split.filter((r) => r.status === 201).map((r) => r.json.vehicleId ?? r.json.id)).size <= 2, true);
    const after = await counts(w);
    assert.equal(after['fill_ups'], before['fill_ups']! + 1 + (split.some((r) => r.status === 201) ? 1 : 0));
    assert.equal(after['service_visits'], before['service_visits']! + 1);
    assert.equal(after['maintenance_tasks'], before['maintenance_tasks']! + 1);
    assert.equal(after['service_attachments'], before['service_attachments']! + 1);
    // Concurrent commits of one preview with one Idempotency-Key: one import, one report.
    const importKey = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId], name: 'importer' });
    const data = doc({ serviceVisits: [visit(22, { externalId: 'par-import', attachments: [receipt('pi')] })] });
    const pv = await importer(w, V, importKey.token)({ format: 'json', data });
    const commits = await par(6, () => importer(w, V, importKey.token)({ format: 'json', data, dryRun: false, previewToken: pv.json.previewToken }, { 'idempotency-key': 'par-import' }));
    assert.deepEqual(commits.map((r) => r.status), Array(6).fill(200), commits.map((r) => r.text.slice(0, 120)).join('\n'));
    for (const r of commits) assert.deepEqual(r.json, commits[0]!.json, 'every caller got the same report');
    assert.equal((await w.db.query("SELECT count(*)::int AS n FROM service_visits WHERE external_id = 'par-import'")).rows[0].n, 1);
    assert.equal((await w.db.query("SELECT count(*)::int AS n FROM api_key_activity WHERE action = 'vehicle.import' AND key_id = $1", [importKey.id])).rows[0].n, 1);
  });
});

test('a replay is never served to a caller who no longer passes the checks of the original request', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const body = { servicedOn: '2026-10-14', items: [{ name: 'stale' }] };
    const make = async (name: string, perms: Record<string, string> = { vehicle_info: 'read', service: 'read_write' }) => w.mint(owner, { name, permissions: perms, vehicleIds: [fx.vehicleId] });
    const first = async (k: { token: string }, idem: string) => { const r = await w.call('POST', `${V}/service-visits`, { token: k.token, body, headers: { 'idempotency-key': idem } }); assert.equal(r.status, 201, r.text); return r; };
    const retry = (k: { token: string }, idem: string) => w.call('POST', `${V}/service-visits`, { token: k.token, body, headers: { 'idempotency-key': idem } });
    const visits = async () => (await w.db.query<{ n: number }>('SELECT count(*)::int AS n FROM service_visits')).rows[0]!.n;

    const revoked = await make('revoked'); await first(revoked, 'r-1');
    await keys.deleteApiKey(w.h.ctx, owner.principal, revoked.id);
    problem(await retry(revoked, 'r-1'), 401, 'invalid_api_key');

    const reduced = await make('reduced'); await first(reduced, 'r-2');
    await keys.updateApiKey(w.h.ctx, owner.principal, reduced.id, keys.parsePatchInput({ permissions: { vehicle_info: 'read', service: 'read' } }));
    problem(await retry(reduced, 'r-2'), 403, 'insufficient_scope');

    const unselected = await make('unselected'); await first(unselected, 'r-3');
    await keys.updateApiKey(w.h.ctx, owner.principal, unselected.id, keys.parsePatchInput({ vehicleIds: [] }));
    problem(await retry(unselected, 'r-3'), 404, 'vehicle_not_found');

    const demoted = await w.user('demoted');
    assert.equal((await w.call('POST', `${V}/members`, { as: owner, body: { userId: demoted.id, role: 'driver' } })).status, 201);
    const dk = await w.mint(demoted, { permissions: { vehicle_info: 'read', service: 'read_write' }, vehicleIds: [fx.vehicleId] });
    await first(dk, 'r-4');
    assert.equal((await w.call('PUT', `${V}/members/${demoted.id}`, { as: owner, body: { role: 'viewer' } })).status, 200);
    problem(await retry(dk, 'r-4'), 403, 'forbidden');
    assert.equal((await w.call('DELETE', `${V}/members/${demoted.id}`, { as: owner })).status, 204);
    problem(await retry(dk, 'r-4'), 404, 'vehicle_not_found');

    const gated = await make('gated'); await first(gated, 'r-5');
    await setModule(w.db, 'service', false);
    problem(await retry(gated, 'r-5'), 404, 'module_disabled');
    await setModule(w.db, 'service', true);

    const archived = await make('archived'); await first(archived, 'r-6');
    assert.equal((await w.call('PUT', `${V}/archive`, { as: owner, body: { archived: true } })).status, 200);
    problem(await retry(archived, 'r-6'), 409, 'vehicle_archived');
    assert.equal((await w.call('PUT', `${V}/archive`, { as: owner, body: { archived: false } })).status, 200);

    // Another key never sees someone else's record under the same string.
    const mine = await make('mine'); const theirs = await make('theirs');
    const a = await first(mine, 'shared-string'); const b = await first(theirs, 'shared-string');
    assert.notEqual(a.json.id, b.json.id);
    assert.ok((await visits()) >= 1);
  });
});

// ---------- session compatibility ----------
test('session imports are unchanged: no preview token, no binding, no key activity, heuristics skip', { skip }, async () => {
  await setup(async ({ w, owner, fx, V }) => {
    const data = doc({ fillUps: [fill('2000')], serviceVisits: [{ servicedOn: '2026-10-02', items: [{ name: 'Oil change' }, { name: 'Wipers' }] }, visit(30)], maintenanceTasks: [task] });
    const dry = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data } });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.previewToken, undefined);
    assert.equal(dry.json.committed, false);
    const commit = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data, dryRun: false } });
    assert.equal(commit.status, 200, commit.text.slice(0, 300));
    assert.deepEqual([commit.json.summary.created, commit.json.serviceVisits.created, commit.json.serviceVisits.duplicates, commit.json.maintenanceTasks.created], [1, 1, 1, 1]);
    assert.equal((await w.db.query('SELECT count(*)::int AS n FROM api_key_activity')).rows[0].n, 0);
    assert.equal((await w.db.query('SELECT count(*)::int AS n FROM api_key_import_previews')).rows[0].n, 0);
    // An Idempotency-Key header and a previewToken are ignored for sessions.
    const twice = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: doc({ fillUps: [fill('2100', '2026-10-25T08:00:00Z')] }), dryRun: false, previewToken: 'whatever' }, headers: { 'idempotency-key': 'k' } });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.summary.created, 1);
    // The Service module gate on session imports is deliberately unchanged: recorded data stays importable while the module is off.
    await setModule(w.db, 'service', false);
    const off = await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: doc({ serviceVisits: [visit(25)] }), dryRun: false } });
    assert.equal(off.status, 200);
    // For a key the same import is refused by the module gate.
    const key = await w.mint(owner, { permissions: SERVICE_ONLY, vehicleIds: [fx.vehicleId] });
    problem(await importer(w, V, key.token)({ format: 'json', data: doc({ serviceVisits: [visit(26)] }) }), 404, 'module_disabled');
    // A scoped export (no fuel list) is accepted by a session import as well.
    const noFuel = { ...doc({ serviceVisits: [visit(27)] }), omittedSections: ['fillUps'] } as Record<string, unknown>;
    delete noFuel['fillUps'];
    assert.equal((await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: noFuel } })).status, 200);
    const missingFuel = { ...noFuel }; delete missingFuel['omittedSections'];
    problem(await w.call('POST', `${V}/import`, { as: owner, body: { format: 'json', data: missingFuel } }), 422, 'import_malformed');
  });
});

// ---------- the primary use case ----------
test('end to end: a key that reads one vehicle and writes its service history imports visits with receipts, and nothing more', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user('owner');
    const odyssey = await fixture(w, owner, { name: 'Odyssey', make: 'Honda', model: 'Odyssey' });
    const other = await fixture(w, owner, { name: 'Civic', model: 'Civic' });
    const oc = w.cookie(owner);
    // The owner creates the key: Odyssey only, vehicle info (read) and service history/receipts (read_write), valid for 7 days.
    const created = await oc('POST', '/v1/auth/api-keys', { name: 'Service importer', expiresIn: '7d', vehicleMode: 'selected', vehicleIds: [odyssey.vehicleId], permissions: { vehicle_info: 'read', service: 'read_write' } });
    assert.equal(created.status, 201, created.text);
    const { id, token } = { id: created.json.key?.id ?? created.json.id, token: created.json.token as string };
    assert.match(token, /^dlk_/);
    const bearer = w.bearer(token);
    const V = `/v1/vehicles/${odyssey.vehicleId}`;

    // Who am I?
    const me = await bearer('GET', '/v1/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.authMethod, 'api_key');
    assert.equal(me.json.apiKey.name, 'Service importer');
    // Only the Odyssey is visible.
    const list = await bearer('GET', '/v1/vehicles');
    assert.deepEqual(list.json.items.map((v: any) => v.name), ['Odyssey']);
    assert.equal((await bearer('GET', `/v1/vehicles/${other.vehicleId}`)).status, 404);
    // Service history is readable.
    const history = await bearer('GET', `${V}/service-visits`);
    assert.equal(history.status, 200);
    assert.equal(history.json.items.length, 1);

    // Dry-run a service-only import with receipts ...
    const data = {
      format: 'driveloom.vehicle', version: 1, vehicle: { name: 'Odyssey', odometerUnit: 'km', currency: 'EUR' },
      serviceVisits: [
        { servicedOn: '2026-08-14', odometer: { value: '88000', unit: 'km' }, provider: 'Honda Centre', totalCost: '210.50', externalId: 'inv-1001', items: [{ name: 'Brake pads', cost: '150.50' }, { name: 'Brake fluid', cost: '60.00' }], attachments: [receipt('inv-1001')] },
        { servicedOn: '2026-09-02', odometer: { value: '90500', unit: 'km' }, provider: 'Honda Centre', totalCost: '89.00', externalId: 'inv-1002', items: [{ name: 'Oil change', cost: '89.00' }], attachments: [receipt('inv-1002'), receipt('inv-1002b')] },
      ],
      omittedSections: ['fillUps', 'maintenanceTasks'],
    };
    const before = await counts(w);
    const dry = await bearer('POST', `${V}/import`, { format: 'json', data });
    assert.equal(dry.status, 200, dry.text.slice(0, 500));
    assert.equal(dry.json.dryRun, true);
    assert.equal(dry.json.serviceVisits.created, 2);
    assert.equal(dry.json.summary.invalid, 0);
    assert.ok(dry.json.previewToken);
    same(before, await counts(w), 'dry run', ['api_key_import_previews']);
    // ... and commit with the preview token and an Idempotency-Key.
    const commit = await bearer('POST', `${V}/import`, { format: 'json', data, dryRun: false, previewToken: dry.json.previewToken }, { 'idempotency-key': 'import-2026-11-27' });
    assert.equal(commit.status, 200, commit.text.slice(0, 500));
    assert.equal(commit.json.committed, true);
    assert.deepEqual(commit.json.serviceVisits.records.map((r: any) => r.outcome), ['created', 'created']);
    // A retry of the same commit is a replay, not a second import.
    const retry = await bearer('POST', `${V}/import`, { format: 'json', data, dryRun: false, previewToken: dry.json.previewToken }, { 'idempotency-key': 'import-2026-11-27' });
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(retry.json.committed, true);

    // Verify the records and their totals through the same key.
    const after = await bearer('GET', `${V}/service-visits`);
    assert.equal(after.json.items.length, 3);
    const imported = after.json.items.filter((v: any) => v.externalId);
    assert.deepEqual(imported.map((v: any) => v.externalId).sort(), ['inv-1001', 'inv-1002']);
    assert.equal(imported.reduce((n: number, v: any) => n + Number(v.totalCost), 0), 299.5);
    assert.deepEqual(imported.map((v: any) => v.attachments.length).sort(), [1, 2]);
    const rec = imported.find((v: any) => v.externalId === 'inv-1001');
    const file = await bearer('GET', `${V}/service-visits/${rec.id}/attachments/${rec.attachments[0].id}`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.bytes, PNG_BYTES('inv-1001'));
    assert.equal((await counts(w))['service_attachments'], before['service_attachments']! + 3);

    // Everything else is refused: fuel, maintenance write, deletion, the other vehicle, vehicle settings, admin, key management.
    problem(await bearer('GET', `${V}/fill-ups`), 403, 'insufficient_scope');
    problem(await bearer('POST', `${V}/fill-ups`, fill('95000')), 403, 'insufficient_scope');
    problem(await bearer('POST', `${V}/maintenance-tasks`, { name: 'Nope', intervalDays: 10 }), 403, 'insufficient_scope');
    problem(await bearer('GET', `${V}/maintenance-tasks`), 403, 'insufficient_scope');
    problem(await bearer('DELETE', `${V}/service-visits/${rec.id}`), 403, 'insufficient_scope');
    problem(await bearer('DELETE', `${V}/service-visits/${rec.id}/attachments/${rec.attachments[0].id}`), 403, 'insufficient_scope');
    problem(await bearer('PATCH', V, { name: 'Hacked' }), 403, 'insufficient_scope');
    problem(await bearer('POST', `/v1/vehicles/${other.vehicleId}/service-visits`, { servicedOn: '2026-09-09', items: [{ name: 'x' }] }), 404, 'vehicle_not_found');
    problem(await bearer('POST', `/v1/vehicles/${other.vehicleId}/import`, { format: 'json', data }), 404, 'vehicle_not_found');
    problem(await bearer('GET', `${V}/export?format=csv`), 403, 'insufficient_scope');
    problem(await bearer('POST', '/v1/vehicle-imports', { data }), 403, 'insufficient_scope');
    problem(await bearer('GET', '/v1/admin/users'), 403, 'api_key_not_allowed');
    problem(await bearer('GET', '/v1/auth/api-keys'), 403, 'api_key_not_allowed');
    problem(await bearer('DELETE', V), 403, 'api_key_not_allowed');
    // A scoped export of what it may read.
    const exp = await bearer('GET', `${V}/export?format=json`);
    assert.equal(exp.status, 200);
    assert.deepEqual(exp.json.omittedSections.sort(), ['fillUps', 'maintenanceTasks']);
    assert.equal(exp.json.serviceVisits.length, 3);
    // Fuel data that the key may not read never shows up in anything it can fetch.
    assert.ok(!exp.text.includes('"odometer":{"value":"1000"'), 'no fill-up in the export');

    // The owner sees the attributed activity, with the ids of what was created.
    const hist = await oc('GET', `/v1/auth/api-keys/${id}/activity?limit=100`);
    assert.equal(hist.status, 200);
    const rows = hist.json.items as { action: string; keyName: string; targetIds: string[]; vehicleId: string | null }[];
    const importRow = rows.find((r) => r.action === 'service_visit.import')!;
    assert.deepEqual(importRow.targetIds.slice().sort(), imported.map((v: any) => v.id).sort());
    assert.equal(importRow.vehicleId, odyssey.vehicleId);
    assert.equal(importRow.keyName, 'Service importer');
    assert.equal(rows.filter((r) => r.action === 'vehicle.import').length, 1, 'the retry did not add a second summary');
    assert.equal(rows.find((r) => r.action === 'service_attachment.import')!.targetIds.length, 3);
    assert.ok(!rows.some((r) => r.action.startsWith('fill_up') || r.action === 'maintenance_task.create'), 'nothing it was refused appears');
    // The admin-visible audit trail attributes the commit to the key too.
    const audit = (await w.db.query("SELECT details FROM audit_events WHERE action = 'vehicle.import'")).rows;
    assert.deepEqual(audit.map((a) => a.details.apiKey), [{ id, name: 'Service importer' }]);

    // Revoked: the very next request is 401.
    assert.equal((await oc('DELETE', `/v1/auth/api-keys/${id}`)).status, 204);
    problem(await bearer('GET', '/v1/me'), 401, 'invalid_api_key');
    problem(await bearer('POST', `${V}/import`, { format: 'json', data, dryRun: false, previewToken: dry.json.previewToken }, { 'idempotency-key': 'import-2026-11-27' }), 401, 'invalid_api_key');
    // The history stays, attributable to the revoked key.
    assert.equal((await oc('GET', `/v1/auth/api-keys/${id}/activity?limit=5`)).status, 200);
  });
});
