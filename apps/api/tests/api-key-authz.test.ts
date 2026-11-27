// API keys, phase 3: authorization. Generated from the route policy table so a new key-accessible route is covered
// the day it is added: every such route x every level its module offers, the extra requirements, vehicle scope in
// all three modes, roles, feature gates, the decided run-time effects (D1-D5, D10), list leakage, audit and rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allRoutes } from '../src/application.ts';
import * as keys from '../src/auth/api-keys.ts';
import { createApiKeyGate, recheckKeyInTx } from '../src/auth/api-key-auth.ts';
import { levelAllows, SUPPORTED_LEVELS, type KeyLevel, type KeyRule, type LevelModule } from '../src/auth/api-key-policy.ts';
import { KEY_ROUTE_POLICIES } from '../src/auth/api-key-route-policies.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { setModule } from '../src/modules.ts';
import type { Route } from '../src/http/app.ts';
import { createApp } from '../src/http/app.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture, keyWorld, PNG_BYTES, type Fixture, type KeyWorld, type Res } from './helpers/keys.ts';
import type { TestUser } from './helpers/index.ts';
import { noProxies, ORIGIN } from './helpers/index.ts';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';
const rid = (r: Pick<Route, 'method' | 'path'>) => `${r.method} ${r.path}`;
const isRule = (k: unknown): k is KeyRule => typeof k === 'object' && k !== null;
const problem = (r: Res, status: number, code: string, label = '') => { assert.equal(r.status, status, `${label} ${r.text.slice(0, 300)}`); assert.equal(r.json?.code, code, `${label} ${r.text.slice(0, 300)}`); };
const scopeDenied = (r: Res, required: string, label = '') => { problem(r, 403, 'insufficient_scope', label); assert.equal(r.json.required, required, `${label} required`); };
const ALL_FULL: Record<string, string> = { vehicle_info: 'read', vehicle_settings: 'full', fuel: 'full', service: 'full', maintenance: 'full', notifications: 'read_write', statistics: 'read' };
const maxLevel = (m: LevelModule): KeyLevel => SUPPORTED_LEVELS[m][SUPPORTED_LEVELS[m].length - 1]!;

// What a successful call looks like for each key-accessible route. Routes without an entry still get the generic
// authorization checks; `every key-accessible route has a success case` fails until one is added.
interface Case { status: number; body?: unknown; raw?: { type: string; data: Buffer }; prep?: 'image'; query?: string }
const EMPTY_EXPORT = { format: 'driveloom.vehicle', version: 1, vehicle: { name: 'Imp', odometerUnit: 'km', currency: 'EUR' }, fillUps: [] };
const CASES: Record<string, Case> = {
  'GET /v1/vehicles': { status: 200 },
  'POST /v1/vehicles': { status: 201, body: { name: 'New', odometerUnit: 'km', currency: 'EUR' } },
  'GET /v1/vehicles/:vehicleId': { status: 200 },
  'PATCH /v1/vehicles/:vehicleId': { status: 200, body: { name: 'Renamed' } },
  'GET /v1/vehicles/:vehicleId/image': { status: 200, prep: 'image' },
  'PUT /v1/vehicles/:vehicleId/image': { status: 204, raw: { type: 'image/png', data: PNG_BYTES() } },
  'DELETE /v1/vehicles/:vehicleId/image': { status: 204, prep: 'image' },
  'GET /v1/vehicles/:vehicleId/fill-ups': { status: 200 },
  'POST /v1/vehicles/:vehicleId/fill-ups': { status: 201, body: { occurredAt: '2026-10-05T08:00:00Z', odometer: { value: '1100', unit: 'km' }, volume: { value: '10', unit: 'l' } } },
  'GET /v1/vehicles/:vehicleId/fill-ups/:fillUpId': { status: 200 },
  'PATCH /v1/vehicles/:vehicleId/fill-ups/:fillUpId': { status: 200, body: { volume: { value: '11', unit: 'l' } } },
  'DELETE /v1/vehicles/:vehicleId/fill-ups/:fillUpId': { status: 204 },
  'GET /v1/vehicles/:vehicleId/stats': { status: 200 },
  'GET /v1/vehicles/:vehicleId/service-visits': { status: 200 },
  'POST /v1/vehicles/:vehicleId/service-visits': { status: 201, body: { servicedOn: '2026-10-03', items: [{ name: 'Tyres' }] } },
  'GET /v1/vehicles/:vehicleId/service-visits/:visitId': { status: 200 },
  'PATCH /v1/vehicles/:vehicleId/service-visits/:visitId': { status: 200, body: { notes: 'checked' } },
  'DELETE /v1/vehicles/:vehicleId/service-visits/:visitId': { status: 204 },
  'POST /v1/vehicles/:vehicleId/service-visits/:visitId/attachments': { status: 201, raw: { type: 'image/png', data: PNG_BYTES('case') } },
  'GET /v1/vehicles/:vehicleId/service-visits/:visitId/attachments/:attachmentId': { status: 200 },
  'PATCH /v1/vehicles/:vehicleId/service-visits/:visitId/attachments/:attachmentId': { status: 200, body: { fileName: 'renamed.png' } },
  'DELETE /v1/vehicles/:vehicleId/service-visits/:visitId/attachments/:attachmentId': { status: 204 },
  'GET /v1/maintenance-catalog': { status: 200 },
  'GET /v1/vehicles/:vehicleId/maintenance-status': { status: 200 },
  'GET /v1/vehicles/:vehicleId/maintenance-tasks': { status: 200 },
  'POST /v1/vehicles/:vehicleId/maintenance-tasks': { status: 201, body: { name: 'Tyres', intervalDays: 180 } },
  'GET /v1/vehicles/:vehicleId/maintenance-tasks/:taskId': { status: 200 },
  'PATCH /v1/vehicles/:vehicleId/maintenance-tasks/:taskId': { status: 200, body: { notes: 'n' } },
  'DELETE /v1/vehicles/:vehicleId/maintenance-tasks/:taskId': { status: 204 },
  'PUT /v1/vehicles/:vehicleId/maintenance-tasks/:taskId/snooze': { status: 200, body: { until: '2026-11-20' } },
  'DELETE /v1/vehicles/:vehicleId/maintenance-tasks/:taskId/snooze': { status: 200 },
  'GET /v1/vehicles/:vehicleId/maintenance/presets': { status: 200 },
  'POST /v1/vehicles/:vehicleId/maintenance/presets/:presetId/apply': { status: 200, body: { tasks: [{ presetTaskId: 'engine-oil' }] } },
  'GET /v1/vehicles/:vehicleId/export': { status: 200, query: '?format=json' },
  'POST /v1/vehicles/:vehicleId/import': { status: 200, body: { format: 'json', data: EMPTY_EXPORT, dryRun: true } },
  'POST /v1/vehicle-imports': { status: 200, body: { data: EMPTY_EXPORT, dryRun: true } },
  'GET /v1/vehicles/:vehicleId/notification-settings': { status: 200 },
  'PUT /v1/vehicles/:vehicleId/notification-settings': { status: 200, body: { emailEnabled: true } },
  'PUT /v1/vehicles/:vehicleId/notification-preferences/me': { status: 200, body: { emailMe: true } },
};

const fill = (path: string, fx: Fixture) => path.replace(':vehicleId', fx.vehicleId).replace(':visitId', fx.visitId).replace(':attachmentId', fx.attachmentId).replace(':fillUpId', fx.fillUpId).replace(':taskId', fx.taskId).replace(':presetId', 'us-honda-odyssey-2015');
const levelsFor = (module: string): (KeyLevel | 'vehicle_create')[] => (module === 'vehicle_create' ? ['none', 'vehicle_create'] : [...SUPPORTED_LEVELS[module as LevelModule]]);
const permsFor = (module: string, level: string, alsos: readonly { module: string }[] = []): Record<string, unknown> => {
  const p: Record<string, string> = {};
  for (const a of alsos) if (a.module !== 'vehicle_create') p[a.module] = maxLevel(a.module as LevelModule);
  if (module !== 'vehicle_create' && level !== 'none') p[module] = level;
  return p;
};
async function putImage(w: KeyWorld, owner: TestUser, fx: Fixture) {
  const r = await w.call('PUT', `/v1/vehicles/${fx.vehicleId}/image`, { as: owner, raw: { type: 'image/png', data: PNG_BYTES() } });
  assert.equal(r.status, 204, r.text);
}
const send = (w: KeyWorld, r: Pick<Route, 'method' | 'path'>, fx: Fixture, token: string, c: Case | undefined) =>
  w.call(r.method, fill(r.path, fx) + (c?.query ?? ''), { token, ...(c?.raw ? { raw: c.raw } : c?.body !== undefined ? { body: c.body } : r.method === 'GET' || r.method === 'DELETE' ? {} : { body: {} }) });

test('every key-accessible route has a success case here (add one when you add a route)', { skip }, async () => {
  await keyWorld(async (w) => {
    const rules = allRoutes(w.h.ctx).filter((r) => isRule(r.key));
    assert.ok(rules.length >= 36, `${rules.length} key-accessible routes`);
    assert.deepEqual(rules.map(rid).filter((id) => !CASES[id]), [], 'routes with no success case');
    assert.deepEqual(Object.keys(CASES).filter((id) => !rules.some((r) => rid(r) === id)), [], 'cases for routes that are not key-accessible');
  });
});

test('table-driven: every key-accessible route x every level its module offers', { skip }, async () => {
  await keyWorld(async (w) => {
    const rules = allRoutes(w.h.ctx).filter((r) => isRule(r.key));
    const sharedOwner = await w.user('shared');
    const shared = await fixture(w, sharedOwner);
    await putImage(w, sharedOwner, shared);
    let checked = 0;
    for (const r of rules) {
      const rule = r.key as KeyRule;
      const c = CASES[rid(r)];
      for (const level of levelsFor(rule.module)) {
        const mutating = r.method !== 'GET';
        const owner = mutating ? await w.user('own') : sharedOwner;
        const fx = mutating ? await fixture(w, owner) : shared;
        if (c?.prep === 'image' && mutating) await putImage(w, owner, fx);
        const { token, id } = await w.mint(owner, { permissions: permsFor(rule.module, level, rule.also ?? []), vehicleCreate: level === 'vehicle_create', vehicleIds: [fx.vehicleId] });
        const res = await send(w, r, fx, token, c);
        const allowed = level === 'vehicle_create' ? true : levelAllows(level, rule.action);
        const label = `${rid(r)} at ${rule.module}=${level}`;
        if (!allowed) scopeDenied(res, `${rule.module}.${rule.action}`, label);
        else {
          assert.ok(!(res.status === 403 && res.json?.code === 'insufficient_scope') && res.status !== 401 && res.json?.code !== 'api_key_not_allowed' && res.json?.code !== 'vehicle_not_found', `${label}: authorized but refused: ${res.text.slice(0, 200)}`);
          if (c) assert.equal(res.status, c.status, `${label}: ${res.text.slice(0, 300)}`);
        }
        if (!mutating) await keys.deleteApiKey(w.h.ctx, owner.principal, id);
        checked++;
      }
    }
    assert.ok(checked >= 120, `${checked} route x level cases`);
  });
});

test('table-driven: every extra requirement is enforced on its own, and the vehicle check comes first', { skip }, async () => {
  await keyWorld(async (w) => {
    const rules = allRoutes(w.h.ctx).filter((r) => isRule(r.key) && (r.key.also?.length ?? 0) > 0);
    assert.ok(rules.length >= 11, `${rules.length} routes with extra requirements`);
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const other = await fixture(w, owner, { name: 'Other' });
    for (const r of rules) {
      const rule = r.key as KeyRule;
      const c = CASES[rid(r)];
      const everyone = [rule, ...(rule.also ?? [])];
      for (const missing of everyone) {
        const perms: Record<string, string> = {};
        for (const x of everyone) if (x !== missing) perms[x.module] = maxLevel(x.module as LevelModule);
        // A module that is both required and "missing" must be absent entirely; others at their top level.
        if (everyone.filter((x) => x.module === missing.module).length > 1) continue;
        const { token, id } = await w.mint(owner, { permissions: perms, vehicleIds: [fx.vehicleId] });
        scopeDenied(await send(w, r, fx, token, c), `${missing.module}.${missing.action}`, `${rid(r)} without ${missing.module}`);
        // Outside the selection the same key gets the ordinary 404, not a hint about permissions.
        if (r.path.includes(':vehicleId')) problem(await send(w, r, other, token, c), 404, 'vehicle_not_found', `${rid(r)} out of scope`);
        await keys.deleteApiKey(w.h.ctx, owner.principal, id);
      }
    }
  });
});

test('vehicle scope: an excluded vehicle is the ordinary 404 on every route, even for a fully privileged key', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const mine = await fixture(w, owner, { name: 'In' });
    const theirs = await fixture(w, owner, { name: 'Out' });
    const { token } = await w.mint(owner, { permissions: ALL_FULL, vehicleCreate: true, vehicleIds: [mine.vehicleId] });
    const rules = allRoutes(w.h.ctx).filter((r) => isRule(r.key) && r.path.includes(':vehicleId'));
    for (const r of rules) {
      problem(await send(w, r, theirs, token, CASES[rid(r)]), 404, 'vehicle_not_found', rid(r));
      // Nonsense ids are the same 404.
      const bogus = await w.call(r.method, r.path.replace(':vehicleId', 'not-a-uuid').replace(/:\w+/g, '00000000-0000-7000-8000-000000000000'), { token, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      problem(bogus, 404, 'vehicle_not_found', `${rid(r)} bogus`);
    }
    // Record ids from another vehicle do not work through an allowed one (no id confusion across vehicles).
    const crossed: Fixture = { vehicleId: mine.vehicleId, visitId: theirs.visitId, attachmentId: theirs.attachmentId, fillUpId: theirs.fillUpId, taskId: theirs.taskId, itemName: '' };
    for (const r of rules.filter((x) => /:(visitId|attachmentId|fillUpId|taskId)/.test(x.path))) {
      const res = await send(w, r, crossed, token, CASES[rid(r)]);
      assert.equal(res.status, 404, `${rid(r)} with another vehicle's record id: ${res.text.slice(0, 200)}`);
    }
  });
});

test('vehicle lists never leak: only the selection, with archived, filters and every mode', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const c = w.cookie(owner);
    const a = await fixture(w, owner, { name: 'A' });
    const b = await fixture(w, owner, { name: 'B' });
    const archived = await fixture(w, owner, { name: 'C (archived)' });
    assert.equal((await c('PUT', `/v1/vehicles/${archived.vehicleId}/archive`, { archived: true })).status, 200);
    const ids = (r: Res) => r.json.items.map((v: { id: string }) => v.id).sort();
    const sel = await w.mint(owner, { permissions: { vehicle_info: 'read' }, vehicleIds: [a.vehicleId, archived.vehicleId] });
    assert.deepEqual(ids(await w.call('GET', '/v1/vehicles', { token: sel.token })), [a.vehicleId].sort(), 'archived is hidden by default as for a session');
    assert.deepEqual(ids(await w.call('GET', '/v1/vehicles?includeArchived=true', { token: sel.token })), [a.vehicleId, archived.vehicleId].sort());
    assert.deepEqual(ids(await w.call('GET', '/v1/vehicles', { as: owner })), [a.vehicleId, b.vehicleId].sort(), 'the session still sees everything');
    const snap = await w.mint(owner, { permissions: { vehicle_info: 'read' }, vehicleMode: 'all_current', name: 'snap' });
    assert.deepEqual(ids(await w.call('GET', '/v1/vehicles?includeArchived=true', { token: snap.token })), [a.vehicleId, b.vehicleId, archived.vehicleId].sort());
    const later = await fixture(w, owner, { name: 'Later' });
    assert.deepEqual(ids(await w.call('GET', '/v1/vehicles', { token: snap.token })), [a.vehicleId, b.vehicleId].sort(), 'all_current: a vehicle created later is not in the snapshot');
    assert.equal((await w.call('GET', `/v1/vehicles/${later.vehicleId}`, { token: snap.token })).status, 404);
    const fut = await w.mint(owner, { permissions: { vehicle_info: 'read' }, vehicleMode: 'all_current_future', name: 'future' });
    assert.deepEqual(ids(await w.call('GET', '/v1/vehicles', { token: fut.token })), [a.vehicleId, b.vehicleId, later.vehicleId].sort(), 'all_current_future includes new vehicles');
    // A vehicle the owner is not a member of never appears, whatever the key says.
    const stranger = await w.user('stranger');
    const foreign = await fixture(w, stranger, { name: 'Foreign' });
    assert.ok(!ids(await w.call('GET', '/v1/vehicles', { token: fut.token })).includes(foreign.vehicleId));
    assert.equal((await w.call('GET', `/v1/vehicles/${foreign.vehicleId}`, { token: fut.token })).status, 404);
    // A key from another user's account cannot be pointed at my vehicles (creation requires access) ...
    await assert.rejects(w.mint(stranger, { vehicleIds: [a.vehicleId] }), (e: any) => e.status === 422);
  });
});

test('three vehicle modes, vehicle creation, and membership loss and regain', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user('owner');
    const other = await w.user('other');
    const oc = w.cookie(owner);
    const base = { permissions: { vehicle_info: 'read', fuel: 'read_write', vehicle_settings: 'read_write' } };
    const v1 = await fixture(w, owner, { name: 'V1' });
    const sel = await w.mint(owner, { ...base, vehicleIds: [v1.vehicleId], vehicleCreate: true, name: 'selected+create' });
    const snap = await w.mint(owner, { ...base, vehicleMode: 'all_current', vehicleCreate: true, name: 'snapshot+create' });
    const fut = await w.mint(owner, { ...base, vehicleMode: 'all_current_future', vehicleCreate: true, name: 'future+create' });
    const noCreate = await w.mint(owner, { ...base, vehicleMode: 'all_current_future', name: 'future, no create' });
    const read = (t: string, id: string) => w.call('GET', `/v1/vehicles/${id}`, { token: t });

    // vehicle_create: refused without the grant; allowed with it; creation never widens a static key.
    scopeDenied(await w.call('POST', '/v1/vehicles', { token: noCreate.token, body: { name: 'X', odometerUnit: 'km', currency: 'EUR' } }), 'vehicle_create.create');
    for (const k of [sel, snap, fut]) {
      const made = await w.call('POST', '/v1/vehicles', { token: k.token, body: { name: `by ${k.view.name}`, odometerUnit: 'km', currency: 'EUR' } });
      assert.equal(made.status, 201, made.text);
      const read2 = await read(k.token, made.json.id);
      if (k === fut) assert.equal(read2.status, 200, 'all_current_future includes the vehicle the key created');
      else problem(read2, 404, 'vehicle_not_found', `${k.view.name} cannot read the vehicle it created`);
      assert.equal((await read(noCreate.token, made.json.id)).status, 200, 'another all_current_future key sees it as well');
      assert.equal((await oc('GET', `/v1/vehicles/${made.json.id}`)).status, 200, 'the owner (session) sees it');
    }
    // The creating key's grants on the new vehicle are the key's, intersected with the owner role (owner): the future key may write.
    const nv = await w.call('POST', '/v1/vehicles', { token: fut.token, body: { name: 'W', odometerUnit: 'km', currency: 'EUR' } });
    assert.equal((await w.call('PATCH', `/v1/vehicles/${nv.json.id}`, { token: fut.token, body: { name: 'W2' } })).status, 200);

    // Membership loss and regain: the owner shares V1 with `other` as editor; a key of `other` follows the live membership.
    assert.equal((await oc('POST', `/v1/vehicles/${v1.vehicleId}/members`, { userId: other.id, role: 'editor' })).status, 201);
    const otherKey = await w.mint(other, { ...base, vehicleIds: [v1.vehicleId], name: 'other selected' });
    const otherFut = await w.mint(other, { ...base, vehicleMode: 'all_current_future', name: 'other future' });
    assert.equal((await read(otherKey.token, v1.vehicleId)).status, 200);
    assert.equal((await read(otherFut.token, v1.vehicleId)).status, 200);
    assert.equal((await oc('DELETE', `/v1/vehicles/${v1.vehicleId}/members/${other.id}`)).status, 204);
    for (const t of [otherKey.token, otherFut.token]) {
      problem(await read(t, v1.vehicleId), 404, 'vehicle_not_found', 'membership lost');
      problem(await w.call('POST', `/v1/vehicles/${v1.vehicleId}/fill-ups`, { token: t, body: CASES['POST /v1/vehicles/:vehicleId/fill-ups']!.body }), 404, 'vehicle_not_found', 'writes too');
    }
    assert.deepEqual((await w.call('GET', '/v1/vehicles', { token: otherKey.token })).json.items, []);
    assert.equal((await oc('POST', `/v1/vehicles/${v1.vehicleId}/members`, { userId: other.id, role: 'viewer' })).status, 201);
    assert.equal((await read(otherKey.token, v1.vehicleId)).status, 200, 'regained membership: the stored selection applies again');
    // ... with the new, lower role underneath the key's grants.
    problem(await w.call('POST', `/v1/vehicles/${v1.vehicleId}/fill-ups`, { token: otherKey.token, body: CASES['POST /v1/vehicles/:vehicleId/fill-ups']!.body }), 403, 'forbidden', 'viewer role beats a read_write key');
    // Editing the key's selection takes effect on the next request.
    await keys.updateApiKey(w.h.ctx, owner.principal, sel.id, keys.parsePatchInput({ vehicleIds: [] }));
    problem(await read(sel.token, v1.vehicleId), 404, 'vehicle_not_found', 'selection reduced');
  });
});

test('roles are intersected with the key: viewer, driver, manager and owner each keep their own limits', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user('owner');
    const oc = w.cookie(owner);
    const fx = await fixture(w, owner);
    const roles = {} as Record<'viewer' | 'driver' | 'editor', { user: TestUser; token: string }>;
    for (const role of ['viewer', 'driver', 'editor'] as const) {
      const user = await w.user(role);
      assert.equal((await oc('POST', `/v1/vehicles/${fx.vehicleId}/members`, { userId: user.id, role })).status, 201);
      roles[role] = { user, token: (await w.mint(user, { permissions: ALL_FULL, vehicleIds: [fx.vehicleId] })).token };
    }
    const ownerKey = (await w.mint(owner, { permissions: ALL_FULL, vehicleIds: [fx.vehicleId] })).token;
    const V = `/v1/vehicles/${fx.vehicleId}`;
    const fillBody = (km: string) => ({ occurredAt: '2026-10-10T08:00:00Z', odometer: { value: km, unit: 'km' }, volume: { value: '10', unit: 'l' } });
    const visitBody = { servicedOn: '2026-10-10', items: [{ name: 'Brake pads' }] };
    // Viewer: reads, never writes, whatever the key says.
    const v = roles.viewer.token;
    assert.equal((await w.call('GET', `${V}/fill-ups`, { token: v })).status, 200);
    for (const [m, p, b] of [['POST', 'fill-ups', fillBody('1200')], ['POST', 'service-visits', visitBody], ['PATCH', '', { name: 'x' }], ['POST', 'maintenance-tasks', { name: 'T', intervalDays: 30 }], ['PUT', 'notification-settings', { emailEnabled: true }]] as const) {
      problem(await w.call(m, `${V}${p ? `/${p}` : ''}`, { token: v, body: b }), 403, 'forbidden', `viewer ${m} ${p}`);
    }
    // Driver: records fuel and visits, but may change only their own, and manages no tasks or vehicle data.
    const d = roles.driver.token;
    const own = await w.call('POST', `${V}/fill-ups`, { token: d, body: fillBody('1300') });
    assert.equal(own.status, 201, own.text);
    assert.equal((await w.call('PATCH', `${V}/fill-ups/${own.json.id}`, { token: d, body: { volume: { value: '12', unit: 'l' } } })).status, 200);
    problem(await w.call('PATCH', `${V}/fill-ups/${fx.fillUpId}`, { token: d, body: { volume: { value: '12', unit: 'l' } } }), 403, 'forbidden', 'driver edits the owner\'s fill-up');
    problem(await w.call('DELETE', `${V}/fill-ups/${fx.fillUpId}`, { token: d }), 403, 'forbidden', 'driver deletes the owner\'s fill-up');
    problem(await w.call('PATCH', `${V}/service-visits/${fx.visitId}`, { token: d, body: { notes: 'x' } }), 403, 'forbidden', 'driver edits the owner\'s visit');
    problem(await w.call('DELETE', `${V}/service-visits/${fx.visitId}/attachments/${fx.attachmentId}`, { token: d }), 403, 'forbidden', 'driver removes the owner\'s receipt');
    problem(await w.call('POST', `${V}/maintenance-tasks`, { token: d, body: { name: 'T', intervalDays: 30 } }), 403, 'forbidden', 'driver creates a task');
    problem(await w.call('PATCH', V, { token: d, body: { name: 'x' } }), 403, 'forbidden', 'driver edits the vehicle');
    // Editor (manager): everything the vehicle role allows, but never the owner-only things (those are session only anyway).
    const e = roles.editor.token;
    assert.equal((await w.call('PATCH', `${V}/fill-ups/${fx.fillUpId}`, { token: e, body: { volume: { value: '13', unit: 'l' } } })).status, 200);
    assert.equal((await w.call('POST', `${V}/maintenance-tasks`, { token: e, body: { name: 'Belt', intervalDays: 30 } })).status, 201);
    assert.equal((await w.call('PATCH', V, { token: e, body: { name: 'by editor' } })).status, 200);
    assert.equal((await w.call('PUT', `${V}/notification-settings`, { token: e, body: { emailEnabled: true } })).status, 200);
    assert.equal((await w.call('DELETE', V, { token: e })).json.code, 'api_key_not_allowed');
    assert.equal((await w.call('POST', `${V}/members`, { token: ownerKey, body: { userId: roles.viewer.user.id, role: 'editor' } })).json.code, 'api_key_not_allowed', 'not even the owner\'s key manages members');
    assert.equal((await w.call('PATCH', V, { token: ownerKey, body: { name: 'by owner' } })).status, 200);
    // Archived vehicles: reads work, writes are the existing 409, with a key as with a session.
    assert.equal((await oc('PUT', `${V}/archive`, { archived: true })).status, 200);
    assert.equal((await w.call('GET', `${V}/fill-ups`, { token: ownerKey })).status, 200);
    problem(await w.call('POST', `${V}/fill-ups`, { token: ownerKey, body: fillBody('1400') }), 409, 'vehicle_archived', 'archived');
  });
});

test('the Service module gate applies underneath: disabled means 404 module_disabled, as for a session', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const { token } = await w.mint(owner, { permissions: ALL_FULL, vehicleIds: [fx.vehicleId] });
    await setModule(w.db, 'service', false);
    const V = `/v1/vehicles/${fx.vehicleId}`;
    for (const [m, p, b] of [['GET', 'service-visits'], ['POST', 'service-visits', { servicedOn: '2026-10-10', items: [{ name: 'X' }] }], ['GET', `service-visits/${fx.visitId}/attachments/${fx.attachmentId}`], ['GET', 'maintenance-tasks'], ['GET', 'maintenance-status'], ['GET', 'notification-settings']] as const) {
      problem(await w.call(m, `${V}/${p}`, { token, ...(b ? { body: b } : {}) }), 404, 'module_disabled', `${m} ${p}`);
    }
    assert.equal((await w.call('GET', `${V}/fill-ups`, { token })).status, 200, 'fuel is not gated');
    await setModule(w.db, 'service', true);
    assert.equal((await w.call('GET', `${V}/service-visits`, { token })).status, 200);
  });
});

// ---------- decided run-time effects ----------
test('D1: a visit patch that removes or renames an item needs service.delete; edits and additions need only update', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const V = `/v1/vehicles/${fx.vehicleId}/service-visits/${fx.visitId}`;
    const rw = (await w.mint(owner, { name: 'rw', permissions: { service: 'read_write', vehicle_info: 'read' }, vehicleIds: [fx.vehicleId] })).token;
    const full = (await w.mint(owner, { name: 'full', permissions: { service: 'full' }, vehicleIds: [fx.vehicleId] })).token;
    const items = (...names: string[]) => ({ items: names.map((name) => ({ name })) });
    assert.equal((await w.call('PATCH', V, { token: rw, body: { notes: 'no items sent' } })).status, 200, 'no items in the patch');
    assert.equal((await w.call('PATCH', V, { token: rw, body: { items: [{ name: 'oil  CHANGE', cost: '10.00' }, { name: 'Wipers', category: 'repair' }] } })).status, 200, 'editing cost/category, name matched canonically');
    assert.equal((await w.call('PATCH', V, { token: rw, body: items('Oil change', 'Wipers', 'Filter') })).status, 200, 'pure addition');
    assert.equal((await w.call('PATCH', V, { token: rw, body: items('Wipers', 'Filter', 'Oil change') })).status, 200, 'reordering drops nothing');
    scopeDenied(await w.call('PATCH', V, { token: rw, body: items('Oil change', 'Wipers') }), 'service.delete', 'dropping one item');
    scopeDenied(await w.call('PATCH', V, { token: rw, body: items('Oil change', 'Wipers', 'Replaced') }), 'service.delete', 'renaming one item');
    scopeDenied(await w.call('PATCH', V, { token: rw, body: items('Oil change') }), 'service.delete', 'dropping two items');
    const after = await w.call('GET', V, { token: rw });
    assert.deepEqual(after.json.items.map((i: { name: string }) => i.name).sort(), ['Filter', 'Oil change', 'Wipers'], 'a refused patch changed nothing');
    assert.equal((await w.call('PATCH', V, { token: full, body: items('Oil change') })).status, 200, 'full may remove');
    // Receipts: removal needs delete, add and rename do not.
    const A = `${V}/attachments`;
    const up = await w.call('POST', A, { token: rw, raw: { type: 'image/png', data: PNG_BYTES('rw upload') } });
    assert.equal(up.status, 201);
    assert.equal((await w.call('PATCH', `${A}/${up.json.id}`, { token: rw, body: { fileName: 'r.png' } })).status, 200);
    scopeDenied(await w.call('DELETE', `${A}/${up.json.id}`, { token: rw }), 'service.delete', 'attachment removal');
    assert.equal((await w.call('DELETE', `${A}/${up.json.id}`, { token: full })).status, 204);
    scopeDenied(await w.call('DELETE', V, { token: rw }), 'service.delete', 'visit removal');
    // A session is not affected by key rules: it may replace items as before (its authority is its role).
    assert.equal((await w.call('PATCH', V, { as: owner, body: items('Anything') })).status, 200);
  });
});

test('D1: linking a service item to a maintenance task needs maintenance.read (create and update)', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const V = `/v1/vehicles/${fx.vehicleId}/service-visits`;
    const svc = (await w.mint(owner, { name: 'svc', permissions: { service: 'full' }, vehicleIds: [fx.vehicleId] })).token;
    const both = (await w.mint(owner, { name: 'both', permissions: { service: 'full', maintenance: 'read' }, vehicleIds: [fx.vehicleId] })).token;
    const linked = { servicedOn: '2026-10-11', items: [{ name: 'Oil', taskId: fx.taskId }] };
    scopeDenied(await w.call('POST', V, { token: svc, body: linked }), 'maintenance.read', 'create with a link');
    assert.equal((await w.call('POST', V, { token: svc, body: { servicedOn: '2026-10-11', items: [{ name: 'Oil' }] } })).status, 201, 'no link, no need');
    const made = await w.call('POST', V, { token: both, body: linked });
    assert.equal(made.status, 201, made.text);
    assert.equal((await w.call('PATCH', `${V}/${made.json.id}`, { token: svc, body: { items: [{ name: 'Oil', taskId: fx.taskId }] } })).status, 200, 'keeping the link it already has needs no grant (M1)');
    scopeDenied(await w.call('PATCH', `${V}/${made.json.id}`, { token: svc, body: { items: [{ name: 'Oil' }] } }), 'maintenance.read', 'unlinking');
    const plain = await w.call('POST', V, { token: svc, body: { servicedOn: '2026-10-12', items: [{ name: 'Oil' }] } });
    scopeDenied(await w.call('PATCH', `${V}/${plain.json.id}`, { token: svc, body: { items: [{ name: 'Oil', taskId: fx.taskId }] } }), 'maintenance.read', 'adding a link');
    assert.equal((await w.call('PATCH', `${V}/${made.json.id}`, { token: both, body: { items: [{ name: 'Oil', taskId: fx.taskId }] } })).status, 200);
    assert.equal((await w.call('PATCH', `${V}/${made.json.id}`, { token: svc, body: { notes: 'n' } })).status, 200, 'unrelated patches are fine');
  });
});

test('D2: notification settings are redacted for keys, and a key cannot name recipients', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user('owner');
    const mate = await w.user('mate');
    const fx = await fixture(w, owner);
    assert.equal((await w.cookie(owner)('POST', `/v1/vehicles/${fx.vehicleId}/members`, { userId: mate.id, role: 'editor' })).status, 201);
    const N = `/v1/vehicles/${fx.vehicleId}/notification-settings`;
    const { token } = await w.mint(owner, { permissions: { notifications: 'read_write' }, vehicleIds: [fx.vehicleId] });
    const session = await w.call('GET', N, { as: owner });
    assert.equal(session.json.recipients.length, 2, 'a session sees every recipient');
    const key = await w.call('GET', N, { token });
    assert.equal(key.status, 200);
    assert.deepEqual(key.json.recipients.map((r: { userId: string }) => r.userId), [owner.id], 'only the key owner\'s own entry');
    assert.equal(key.json.otherRecipientCount, 1);
    assert.ok(!key.text.includes(mate.email) && !key.text.includes(mate.id), 'no other member\'s address or id');
    const put = await w.call('PUT', N, { token, body: { emailEnabled: true, followUpDays: 3 } });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes(mate.email), 'the update response is redacted as well');
    problem(await w.call('PUT', N, { token, body: { recipientUserIds: [mate.id] } }), 403, 'api_key_not_allowed', 'naming recipients');
    problem(await w.call('PUT', N, { token, body: { recipientUserIds: [] } }), 403, 'api_key_not_allowed', 'clearing recipients');
    assert.equal((await w.call('GET', N, { as: owner })).json.recipients.length, 2, 'nothing changed for the session view');
    assert.equal((await w.call('PUT', `/v1/vehicles/${fx.vehicleId}/notification-preferences/me`, { token, body: { emailMe: false } })).status, 200);
  });
});

test('D3 and D10: derived data needs its source modules (maintenance status/tasks need service.read + fuel.read; stats need fuel.read)', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const V = `/v1/vehicles/${fx.vehicleId}`;
    const mk = async (permissions: Record<string, string>) => (await w.mint(owner, { permissions, vehicleIds: [fx.vehicleId] })).token;
    const m = await mk({ maintenance: 'full' });
    scopeDenied(await w.call('GET', `${V}/maintenance-status`, { token: m }), 'service.read');
    scopeDenied(await w.call('GET', `${V}/maintenance-tasks`, { token: m }), 'service.read');
    scopeDenied(await w.call('POST', `${V}/maintenance-tasks`, { token: m, body: { name: 'T', intervalDays: 10 } }), 'service.read', 'a write response carries derived data too');
    const ms = await mk({ maintenance: 'read', service: 'read' });
    scopeDenied(await w.call('GET', `${V}/maintenance-status`, { token: ms }), 'fuel.read');
    const msf = await mk({ maintenance: 'read', service: 'read', fuel: 'read' });
    assert.equal((await w.call('GET', `${V}/maintenance-status`, { token: msf })).status, 200);
    assert.equal((await w.call('GET', '/v1/maintenance-catalog', { token: m })).status, 200, 'the catalog is static names');
    const s = await mk({ statistics: 'read' });
    scopeDenied(await w.call('GET', `${V}/stats`, { token: s }), 'fuel.read');
    assert.equal((await w.call('GET', `${V}/stats`, { token: await mk({ statistics: 'read', fuel: 'read' }) })).status, 200);
    scopeDenied(await w.call('GET', `${V}/stats`, { token: await mk({ fuel: 'full' }) }), 'statistics.read', 'fuel alone is not statistics');
  });
});

test('D4: deleting a task needs service.update because it unlinks service items', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const linked = await w.call('POST', `/v1/vehicles/${fx.vehicleId}/service-visits`, { as: owner, body: { servicedOn: '2026-10-11', items: [{ name: 'Oil', taskId: fx.taskId }] } });
    assert.equal(linked.status, 201);
    const T = `/v1/vehicles/${fx.vehicleId}/maintenance-tasks/${fx.taskId}`;
    const only = (await w.mint(owner, { permissions: { maintenance: 'full' }, vehicleIds: [fx.vehicleId] })).token;
    scopeDenied(await w.call('DELETE', T, { token: only }), 'service.update');
    assert.equal((await w.call('GET', `/v1/vehicles/${fx.vehicleId}/service-visits/${linked.json.id}`, { as: owner })).json.items[0].taskId, fx.taskId, 'nothing was unlinked');
    const ok = (await w.mint(owner, { permissions: { maintenance: 'full', service: 'read_write' }, vehicleIds: [fx.vehicleId] })).token;
    assert.equal((await w.call('DELETE', T, { token: ok })).status, 204);
    assert.equal((await w.call('GET', `/v1/vehicles/${fx.vehicleId}/service-visits/${linked.json.id}`, { as: owner })).json.items[0].taskId, null, 'the link was cleared');
    // maintenance.update alone is not enough to delete a task.
    const f2 = await fixture(w, owner);
    const upd = (await w.mint(owner, { permissions: { maintenance: 'read_write', service: 'full' }, vehicleIds: [f2.vehicleId] })).token;
    scopeDenied(await w.call('DELETE', `/v1/vehicles/${f2.vehicleId}/maintenance-tasks/${f2.taskId}`, { token: upd }), 'maintenance.delete');
  });
});

test('D5: a preset preview needs exactly the grants of its commit', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const mk = async (fx: Fixture, service: string) => (await w.mint(owner, { permissions: { maintenance: 'read_write', service, fuel: 'read' }, vehicleIds: [fx.vehicleId] })).token;
    const url = (fx: Fixture, preview: boolean) => `/v1/vehicles/${fx.vehicleId}/maintenance/presets/us-honda-odyssey-2015/apply${preview ? '?preview=true' : ''}`;
    for (const level of ['read', 'read_write', 'full']) {
      const fx = await fixture(w, owner);
      const unlinked = (await w.call('GET', `/v1/vehicles/${fx.vehicleId}/service-visits/${fx.visitId}`, { as: owner })).json.items[0].id;
      const t = await mk(fx, level);
      const plain = { tasks: [{ presetTaskId: 'engine-oil' }] };
      const linking = { tasks: [{ presetTaskId: 'engine-oil', baseline: { kind: 'reported', linkServiceItemId: unlinked } }] };
      const outcomes: Record<string, number[]> = {};
      for (const [name, body] of [['plain', plain], ['linking', linking]] as const) {
        const pre = await w.call('POST', url(fx, true), { token: t, body });
        const commit = await w.call('POST', url(fx, false), { token: t, body });
        assert.equal(pre.status, commit.status, `${level}/${name}: preview and commit agree (${pre.text.slice(0, 120)} / ${commit.text.slice(0, 120)})`);
        if (pre.status === 403) { assert.equal(pre.json.required, commit.json.required); assert.equal(pre.json.code, 'insufficient_scope'); }
        outcomes[name] = [pre.status, commit.status];
        // A refused apply wrote nothing; a preview never writes.
      }
      assert.deepEqual(outcomes['plain'], [200, 200], `${level}: creating tasks needs only maintenance.create + the derived reads`);
      if (level === 'read') {
        assert.deepEqual(outcomes['linking'], [403, 403], 'linking an existing service item needs service.update');
        scopeDenied(await w.call('POST', url(fx, true), { token: t, body: linking }), 'service.update');
      } else assert.equal(outcomes['linking']![0], 200);
    }
    // Preview writes nothing, for a key as for a session.
    const fx = await fixture(w, owner);
    const t = await mk(fx, 'read_write');
    const before = (await w.db.query('SELECT count(*)::int AS n FROM maintenance_tasks WHERE vehicle_id = $1', [fx.vehicleId])).rows[0].n;
    const pre = await w.call('POST', url(fx, true), { token: t, body: { tasks: [{ presetTaskId: 'brake-fluid' }] } });
    assert.equal(pre.status, 200);
    assert.equal((await w.db.query('SELECT count(*)::int AS n FROM maintenance_tasks WHERE vehicle_id = $1', [fx.vehicleId])).rows[0].n, before);
    const recorded = async () => (await w.db.query("SELECT count(*)::int AS n FROM api_key_activity WHERE action = 'maintenance_preset.apply'")).rows[0].n;
    const was = await recorded();
    assert.equal((await w.call('POST', url(fx, true), { token: t, body: { tasks: [{ presetTaskId: 'wiper-blades' }] } })).status, 200);
    assert.equal(await recorded(), was, 'a preview is not a recorded write');
  });
});

// ---------- run-time guards ----------
test('a rule with a run-time effect the server cannot enforce yet is refused for keys (fails closed)', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const { token } = await w.mint(owner, { permissions: { vehicle_info: 'read' }, vehicleMode: 'all_current_future' });
    const routes: Route[] = [
      { method: 'GET', path: '/v1/x/enforced', key: { module: 'vehicle_info', action: 'read', dynamic: ['task_link'] }, handler: async () => ({ status: 200, body: {} }) },
      { method: 'GET', path: '/v1/x/payload', key: { module: 'vehicle_info', action: 'read', dynamic: ['future_effect' as never] }, handler: async () => ({ status: 200, body: {} }) },
      { method: 'POST', path: '/v1/x/commit', key: { module: 'vehicle_info', action: 'read', dynamic: ['preview_equals_commit', 'future_effect' as never] }, handler: async () => ({ status: 200, body: {} }) },
      { method: 'GET', path: '/v1/x/bogus', key: { module: 'friends' as never, action: 'read' }, handler: async () => ({ status: 200, body: {} }) },
      { method: 'GET', path: '/v1/x/badaction', key: { module: 'vehicle_info', action: 'delete' as never }, handler: async () => ({ status: 200, body: {} }) },
    ];
    const app = createApp({ routes, authenticator: { resolveSession: async () => null }, publicOrigin: ORIGIN, ipTrust: noProxies, apiKeys: createApiKeyGate(w.h.ctx) });
    const server = createServer((q, s) => void app(q, s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const get = async (p: string, m = 'GET') => { const r = await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}` }, ...(m === 'POST' ? { body: '{}', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } } : {}) }); return { status: r.status, json: (await r.json()) as { code: string } }; };
      assert.equal((await get('/v1/x/enforced')).status, 200);
      for (const p of ['/v1/x/payload', '/v1/x/bogus', '/v1/x/badaction']) { const r = await get(p); assert.equal(r.status, p === '/v1/x/payload' ? 403 : 403, p); assert.ok(['api_key_not_allowed', 'insufficient_scope'].includes(r.json.code), `${p}: ${r.json.code}`); }
      assert.equal((await get('/v1/x/payload')).json.code, 'api_key_not_allowed');
      assert.equal((await get('/v1/x/commit', 'POST')).json.code, 'api_key_not_allowed');
    } finally { server.close(); server.closeAllConnections(); }
  });
});

test('the key is re-checked inside the write transaction: revocation, scope and grant changes beat a request already in flight', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const other = await fixture(w, owner, { name: 'Other' });
    const gate = createApiKeyGate(w.h.ctx);
    const vehicles = new VehicleService(w.db as never);
    const route = allRoutes(w.h.ctx).find((r) => rid(r) === 'PATCH /v1/vehicles/:vehicleId')!;
    const authenticate = async (token: string, vehicleId: string) => gate.authenticate({ token, ip: '127.0.0.1', route, params: { vehicleId }, requestId: null });
    const fresh = async (over: Record<string, unknown> = {}) => {
      const k = await w.mint(owner, { permissions: { vehicle_settings: 'read_write', vehicle_info: 'read' }, vehicleIds: [fx.vehicleId, other.vehicleId], ...over });
      return { ...k, p: await authenticate(k.token, fx.vehicleId) };
    };
    // Control: authenticated and not changed behind its back.
    const ok = await fresh();
    assert.equal((await vehicles.update(ok.p, fx.vehicleId, { name: 'fine' })).name, 'fine');
    // Revoked after authentication, before the write.
    const rev = await fresh();
    await keys.deleteApiKey(w.h.ctx, owner.principal, rev.id);
    await assert.rejects(vehicles.update(rev.p, fx.vehicleId, { name: 'too late' }), (e: any) => e.status === 401 && e.code === 'invalid_api_key');
    // Vehicle removed from the selection after authentication.
    const scoped = await fresh();
    await keys.updateApiKey(w.h.ctx, owner.principal, scoped.id, keys.parsePatchInput({ vehicleIds: [other.vehicleId] }));
    await assert.rejects(vehicles.update(scoped.p, fx.vehicleId, { name: 'out' }), (e: any) => e.status === 404 && e.code === 'vehicle_not_found');
    // Permission reduced after authentication.
    const reduced = await fresh();
    await keys.updateApiKey(w.h.ctx, owner.principal, reduced.id, keys.parsePatchInput({ permissions: { vehicle_info: 'read' } }));
    await assert.rejects(vehicles.update(reduced.p, fx.vehicleId, { name: 'weaker' }), (e: any) => e.status === 403 && e.code === 'insufficient_scope' && e.extra.required === 'vehicle_settings.update');
    // Owner disabled / instance switched off.
    const off = await fresh();
    await keys.setApiKeysEnabled(w.db, false);
    await assert.rejects(vehicles.update(off.p, fx.vehicleId, { name: 'off' }), (e: any) => e.code === 'api_keys_disabled');
    await keys.setApiKeysEnabled(w.db, true);
    // Nothing was written by any refused attempt.
    assert.equal((await w.cookie(owner)('GET', `/v1/vehicles/${fx.vehicleId}`)).json.name, 'fine');
    // Sessions are a no-op for the re-check.
    await recheckKeyInTx(w.db, owner.principal, fx.vehicleId);
  });
});

// ---------- audit ----------
test('writes made with a key are audited with the key id and name and recorded in its history, in the same transaction', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const { id, token } = await w.mint(owner, { name: 'Importer', permissions: { fuel: 'full', service: 'full', vehicle_info: 'read' }, vehicleIds: [fx.vehicleId] });
    const V = `/v1/vehicles/${fx.vehicleId}`;
    const rq = 'req-12345';
    const made = await w.call('POST', `${V}/fill-ups`, { token, body: CASES['POST /v1/vehicles/:vehicleId/fill-ups']!.body, headers: { 'x-request-id': rq } });
    assert.equal(made.status, 201);
    assert.equal(made.headers.get('x-request-id'), rq);
    const act = async () => (await w.db.query("SELECT * FROM api_key_activity WHERE key_id = $1 AND target_type IS DISTINCT FROM 'api_key' ORDER BY id", [id])).rows;
    let rows = await act();
    assert.equal(rows.length, 1);
    assert.deepEqual({ action: rows[0].action, key_name: rows[0].key_name, user_id: rows[0].user_id, vehicle_id: rows[0].vehicle_id, target_type: rows[0].target_type, target_ids: rows[0].target_ids, request_id: rows[0].request_id },
      { action: 'fill_up.create', key_name: 'Importer', user_id: owner.id, vehicle_id: fx.vehicleId, target_type: 'fill_up', target_ids: [made.json.id], request_id: rq });
    const audit = (await w.db.query("SELECT actor_id, details FROM audit_events WHERE action = 'fill_up.create' AND subject_id = $1 ORDER BY id DESC LIMIT 1", [fx.vehicleId])).rows[0];
    assert.equal(audit.actor_id, owner.id);
    assert.deepEqual(audit.details.apiKey, { id, name: 'Importer' });
    // Reads are never logged; refused and invalid requests neither.
    await w.call('GET', `${V}/fill-ups`, { token }); await w.call('GET', `${V}/service-visits`, { token });
    await w.call('POST', `${V}/maintenance-tasks`, { token, body: { name: 'x' } });
    await w.call('POST', `${V}/fill-ups`, { token, body: { bogus: 1 } });
    assert.equal((await act()).length, 1, 'only the successful write');
    // Other writers: visit, attachment, delete.
    const visit = await w.call('POST', `${V}/service-visits`, { token, body: { servicedOn: '2026-10-12', items: [{ name: 'A' }] } });
    const att = await w.call('POST', `${V}/service-visits/${visit.json.id}/attachments`, { token, raw: { type: 'image/png', data: PNG_BYTES() } });
    await w.call('DELETE', `${V}/service-visits/${visit.json.id}`, { token });
    rows = await act();
    assert.deepEqual(rows.map((r) => r.action), ['fill_up.create', 'service_visit.create', 'service_attachment.add', 'service_visit.delete']);
    assert.deepEqual(rows[2].target_ids, [att.json.id]);
    for (const r of rows) assert.ok(!JSON.stringify(r).includes(token), 'no secret');
    // A session write leaves no key history and no key attribution.
    await w.call('POST', `${V}/fill-ups`, { as: owner, body: { ...CASES['POST /v1/vehicles/:vehicleId/fill-ups']!.body as object, occurredAt: '2026-10-06T08:00:00Z', odometer: { value: '1150', unit: 'km' } } });
    assert.equal((await act()).length, 4);
    assert.equal((await w.db.query("SELECT count(*)::int AS n FROM audit_events WHERE details ? 'apiKey' AND details->'apiKey'->>'id' <> $1", [id])).rows[0].n, 0);
    // The history is owner-visible through the key lifecycle API, and survives revocation with the key's identity.
    await keys.deleteApiKey(w.h.ctx, owner.principal, id);
    const hist = await keys.listKeyActivity(w.h.ctx, owner.principal, id, { limit: 50, before: null });
    assert.ok(hist.items.some((i) => i.action === 'fill_up.create' && i.keyName === 'Importer'));
  });
});

test('audit and key history roll back together with a failed write', { skip }, async () => {
  await keyWorld(async (w) => {
    const owner = await w.user();
    const fx = await fixture(w, owner);
    const { id, token } = await w.mint(owner, { permissions: { fuel: 'full' }, vehicleIds: [fx.vehicleId] });
    const count = async (sql: string, args: unknown[] = []) => (await w.db.query<{ n: number }>(sql, args)).rows[0]!.n;
    const before = { fills: await count('SELECT count(*)::int AS n FROM fill_ups'), audit: await count('SELECT count(*)::int AS n FROM audit_events'), act: await count('SELECT count(*)::int AS n FROM api_key_activity') };
    // The key history is the last statement of the transaction: make it fail and everything before it must vanish.
    await w.db.query(`CREATE FUNCTION fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await w.db.query("CREATE TRIGGER fail_activity BEFORE INSERT ON api_key_activity FOR EACH ROW WHEN (NEW.action = 'fill_up.create') EXECUTE FUNCTION fail_activity()");
    const r = await w.call('POST', `/v1/vehicles/${fx.vehicleId}/fill-ups`, { token, body: CASES['POST /v1/vehicles/:vehicleId/fill-ups']!.body });
    assert.equal(r.status, 500);
    assert.equal(await count('SELECT count(*)::int AS n FROM fill_ups'), before.fills, 'the fill-up was rolled back');
    assert.equal(await count('SELECT count(*)::int AS n FROM audit_events'), before.audit, 'the audit row was rolled back');
    assert.equal(await count('SELECT count(*)::int AS n FROM api_key_activity'), before.act, 'no history row');
    await w.db.query('DROP TRIGGER fail_activity ON api_key_activity');
    assert.equal((await w.call('POST', `/v1/vehicles/${fx.vehicleId}/fill-ups`, { token, body: CASES['POST /v1/vehicles/:vehicleId/fill-ups']!.body })).status, 201, 'and it works again');
    assert.equal(await count('SELECT count(*)::int AS n FROM api_key_activity WHERE key_id = $1 AND target_type IS DISTINCT FROM \'api_key\'', [id]), 1);
  });
});

test('raw audit inserts live in one file', { skip: false }, async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const hits: string[] = [];
  const walk = async (dir: URL) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) await walk(u);
      else if (e.name.endsWith('.ts') && /INSERT INTO audit_events/.test(await readFile(u, 'utf8'))) hits.push(u.pathname.replace(/.*\/src\//, 'src/'));
    }
  };
  await walk(new URL('../src/', import.meta.url));
  assert.deepEqual(hits, ['src/audit-insert.ts']);
});
