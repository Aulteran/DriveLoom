// Contract for API-key route classification. The route list comes from the
// real composition root (allRoutes), so a route added anywhere in the API
// appears here automatically and fails until it is classified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allRoutes } from '../src/application.ts';
import type { Route } from '../src/http/app.ts';
import type { AuthContext } from '../src/auth/context.ts';
import {
  BOOLEAN_MODULES, KEY_ACTIONS, KEY_DYNAMIC, KEY_LEVELS, KEY_MODULES, LEVEL_MODULES, MODULE_ACTIONS, SUPPORTED_LEVELS,
  grantsAllow, isKeyAction, isKeyLevel, isKeyModule, isSupportedLevel, levelAllows, rulePermits,
  type KeyGrants, type KeyPolicy, type KeyRule,
} from '../src/auth/api-key-policy.ts';
import { KEY_ROUTE_POLICIES, keyPolicyOf, withKeyPolicies } from '../src/auth/api-key-route-policies.ts';

// Services only store the pool; no route handler runs here.
const ctx = { db: {} as never, config: {} as never, mailer: null, oidc: null, now: () => new Date() } as AuthContext;
const routes = allRoutes(ctx);
const id = (r: Pick<Route, 'method' | 'path'>) => `${r.method} ${r.path}`;
const isRule = (p: KeyPolicy | undefined): p is KeyRule => typeof p === 'object' && p !== null;

test('the route enumeration covers the whole API', () => {
  assert.equal(new Set(routes.map(id)).size, routes.length, 'method+path must be unique');
  for (const sample of ['GET /v1/health', 'POST /v1/auth/login', 'GET /v1/admin/users', 'GET /v1/vehicles', 'POST /v1/vehicles/:vehicleId/fill-ups',
    'POST /v1/vehicles/:vehicleId/service-visits/:visitId/attachments', 'GET /v1/vehicles/:vehicleId/maintenance-status',
    'PUT /v1/vehicles/:vehicleId/notification-settings', 'GET /v1/friends', 'GET /v1/preferences', 'POST /v1/vehicle-imports', 'PUT /v1/vehicles/:vehicleId/image']) {
    assert.ok(routes.some((r) => id(r) === sample), `${sample} is registered`);
  }
});

test('every route is explicitly classified, and nothing is classified that is not a route', () => {
  const missing = routes.filter((r) => r.key === undefined).map(id);
  assert.deepEqual(missing, [], 'routes without a declared key policy (add them to src/auth/api-key-route-policies.ts)');
  const registered = new Set(routes.map(id));
  const stale = Object.keys(KEY_ROUTE_POLICIES).filter((k) => !registered.has(k));
  assert.deepEqual(stale, [], 'policy entries that match no route');
  for (const r of routes) assert.equal(r.key, KEY_ROUTE_POLICIES[id(r)], `${id(r)} carries the table's entry`);
});

test('the declared policy survives the odometer-trigger wrapper used in production', () => {
  const wrapped = allRoutes(ctx, { afterOdometerChange: () => undefined } as never);
  assert.equal(wrapped.length, routes.length);
  for (const r of wrapped) assert.equal(r.key, KEY_ROUTE_POLICIES[id(r)], id(r));
});

test('an undeclared route is session-only', () => {
  const bare: Route = { method: 'GET', path: '/v1/not-in-the-table', handler: async () => ({ status: 200 }) };
  assert.equal(keyPolicyOf(bare), 'session_only');
  assert.equal(withKeyPolicies([bare])[0]!.key, undefined);
  // Prototype keys are not policies.
  assert.equal(withKeyPolicies([{ ...bare, method: 'GET', path: '__proto__' }])[0]!.key, undefined);
});

test('policies are well formed: modules, actions and effects come from closed lists', () => {
  for (const [route, p] of Object.entries(KEY_ROUTE_POLICIES)) {
    if (!isRule(p)) { assert.ok(['session_only', 'public', 'any_key'].includes(p as string), `${route}: unknown policy ${String(p)}`); continue; }
    const extra = Object.keys(p).filter((k) => !['module', 'action', 'also', 'dynamic'].includes(k));
    assert.deepEqual(extra, [], `${route}: unknown fields`);
    for (const req of [p, ...(p.also ?? [])]) {
      assert.ok(isKeyModule(req.module), `${route}: unknown module ${String(req.module)}`);
      assert.ok(isKeyAction(req.action), `${route}: unknown action ${String(req.action)}`);
      assert.ok(MODULE_ACTIONS[req.module].includes(req.action), `${route}: ${req.module} has no ${req.action} action`);
    }
    for (const d of p.dynamic ?? []) assert.ok((KEY_DYNAMIC as readonly string[]).includes(d), `${route}: unknown effect ${d}`);
  }
});

test('every declared requirement can be met by some supported level', () => {
  for (const m of KEY_MODULES) {
    for (const a of MODULE_ACTIONS[m]) {
      const ok = (BOOLEAN_MODULES as readonly string[]).includes(m)
        ? a === 'create'
        : SUPPORTED_LEVELS[m as (typeof LEVEL_MODULES)[number]].some((l) => levelAllows(l, a));
      assert.ok(ok, `${m}.${a} is unreachable`);
    }
  }
});

// The spec's always-session-only list, written independently of the table.
const SESSION_ONLY: [RegExp, RegExp][] = [
  [/^.*$/, /^\/v1\/auth\//],
  [/^.*$/, /^\/v1\/admin\//],
  [/^.*$/, /api-keys/],
  [/^DELETE$/, /^\/v1\/vehicles\/:vehicleId$/], // permanent deletion
  [/^.*$/, /\/archive$/],
  [/^.*$/, /\/owner$/], // ownership transfer and recovery
  [/^.*$/, /\/members(\/|$)/],
  [/^.*$/, /^\/v1\/friends/],
  [/^.*$/, /\/comparisons?$/],
  [/^.*$/, /^\/v1\/preferences$/], // account-wide preferences
  [/^.*$/, /\/service-visibility$/],
];

test('routes the spec reserves for sessions are never key-accessible', () => {
  const hits = routes.filter((r) => SESSION_ONLY.some(([m, p]) => m.test(r.method) && p.test(r.path)));
  assert.ok(hits.length >= 50, 'the reserved set is not empty');
  for (const r of hits) assert.equal(keyPolicyOf(r), 'session_only', `${id(r)} must stay session-only`);
});

test('only authenticated-with-session routes can be key-accessible', () => {
  for (const r of routes) {
    const p = keyPolicyOf(r);
    if (isRule(p)) assert.ok((r.auth ?? 'required') === 'required', `${id(r)}: ${r.auth} routes never take a key`);
    if (r.auth === 'pending' || r.auth === 'optional') assert.equal(p, 'session_only', id(r));
    if (p === 'public') assert.ok(r.auth === 'none' && !/^\/v1\/(auth|admin)\//.test(r.path), `${id(r)}: public is only for unauthenticated routes outside auth and admin`);
    if (p === 'any_key') assert.equal(id(r), 'GET /v1/me', `${id(r)}: only GET /v1/me may accept any key`);
    if (r.auth === 'none') assert.ok(p === 'public' || p === 'session_only', id(r));
  }
  assert.deepEqual(routes.filter((r) => keyPolicyOf(r) === 'public').map(id).sort(), ['GET /v1/health', 'GET /v1/version']);
});

test('modules follow the route they protect (independent of the table)', () => {
  const expect: [RegExp, RegExp, string][] = [
    [/^.*$/, /\/fill-ups/, 'fuel'],
    [/^.*$/, /\/service-visits/, 'service'],
    [/^.*$/, /\/maintenance/, 'maintenance'],
    [/^.*$/, /\/notification-/, 'notifications'],
    [/^.*$/, /\/stats$/, 'statistics'],
    [/^GET$/, /\/image$/, 'vehicle_info'],
    [/^(PUT|DELETE)$/, /\/image$/, 'vehicle_settings'],
    [/^PATCH$/, /^\/v1\/vehicles\/:vehicleId$/, 'vehicle_settings'],
    [/^(GET)$/, /^\/v1\/vehicles(\/:vehicleId)?$/, 'vehicle_info'],
    [/^POST$/, /^\/v1\/vehicles$/, 'vehicle_create'],
  ];
  for (const r of routes) {
    for (const [m, p, module] of expect) {
      if (m.test(r.method) && p.test(r.path)) {
        const pol = keyPolicyOf(r);
        assert.ok(isRule(pol) && pol.module === module, `${id(r)} must require ${module}`);
      }
    }
  }
  const stats = keyPolicyOf(routes.find((r) => r.path.endsWith('/stats'))!) as KeyRule;
  assert.deepEqual(stats.also, [{ module: 'fuel', action: 'read' }], 'statistics also need the source module');
  // D3/D4: derived maintenance data needs the source modules; deleting a task unlinks service items.
  const derived = [{ module: 'service', action: 'read' }, { module: 'fuel', action: 'read' }];
  for (const [route, also] of [
    ['GET /v1/vehicles/:vehicleId/maintenance-status', derived], ['GET /v1/vehicles/:vehicleId/maintenance-tasks', derived], ['GET /v1/vehicles/:vehicleId/maintenance-tasks/:taskId', derived],
    ['POST /v1/vehicles/:vehicleId/maintenance-tasks', derived], ['PATCH /v1/vehicles/:vehicleId/maintenance-tasks/:taskId', derived], ['PUT /v1/vehicles/:vehicleId/maintenance-tasks/:taskId/snooze', derived],
    ['DELETE /v1/vehicles/:vehicleId/maintenance-tasks/:taskId/snooze', derived], ['GET /v1/vehicles/:vehicleId/maintenance/presets', derived], ['POST /v1/vehicles/:vehicleId/maintenance/presets/:presetId/apply', derived],
    ['DELETE /v1/vehicles/:vehicleId/maintenance-tasks/:taskId', [{ module: 'service', action: 'update' }]],
  ] as const) assert.deepEqual((KEY_ROUTE_POLICIES[route] as KeyRule).also, also, route);
  assert.equal((KEY_ROUTE_POLICIES['GET /v1/maintenance-catalog'] as KeyRule).also, undefined, 'the catalog is static names');
});

test('verbs and actions agree, except for the documented semantic cases', () => {
  const nonGetRead = new Set(['POST /v1/vehicles/:vehicleId/import']); // dry run by default; needs only entry access, sections add the rest
  for (const r of routes) {
    const p = keyPolicyOf(r);
    if (!isRule(p)) continue;
    if (r.method === 'GET') assert.equal(p.action, 'read', id(r));
    if (r.method === 'DELETE') assert.equal(p.action, 'delete', id(r));
    if (r.method === 'POST' && p.action !== 'create') assert.ok(nonGetRead.has(id(r)), `${id(r)}: POST that is not a create`);
    if (r.method !== 'GET' && p.action === 'read') assert.ok(nonGetRead.has(id(r)), `${id(r)}: a write route requiring only read`);
    if (p.action === 'delete') assert.ok(r.method === 'DELETE', `${id(r)}: delete action on ${r.method}`);
  }
  // Semantics the verb alone would get wrong are flagged for run-time enforcement.
  const need = (route: string, d: string) => assert.ok((KEY_ROUTE_POLICIES[route] as KeyRule).dynamic?.includes(d as never), `${route} needs ${d}`);
  need('PATCH /v1/vehicles/:vehicleId/service-visits/:visitId', 'nested_delete');
  need('POST /v1/vehicles/:vehicleId/maintenance/presets/:presetId/apply', 'preview_equals_commit');
  // Import and export stay session-only until their payload sections can be enforced (Phase 4); then these rows return as rules.
  for (const r of ['POST /v1/vehicles/:vehicleId/import', 'POST /v1/vehicle-imports', 'GET /v1/vehicles/:vehicleId/export']) assert.equal(KEY_ROUTE_POLICIES[r], 'session_only', `${r} is closed to keys until payload sections are enforced`);
  need('GET /v1/vehicles/:vehicleId/notification-settings', 'redact_members');
});

test('levels allow exactly the actions the spec gives them', () => {
  const table: Record<string, string[]> = { none: [], read: ['read'], read_write: ['read', 'create', 'update'], full: ['read', 'create', 'update', 'delete'] };
  for (const l of KEY_LEVELS) for (const a of KEY_ACTIONS) assert.equal(levelAllows(l, a), table[l]!.includes(a), `${l} / ${a}`);
});

test('unknown levels and actions are denied, so unknown grants fail closed', () => {
  for (const l of ['', 'admin', 'write', 'FULL', 'Read', null, undefined, 1, {}, ['full']]) {
    assert.equal(levelAllows(l, 'read'), false, `level ${String(l)}`);
    assert.equal(isKeyLevel(l), false);
  }
  for (const a of ['', 'write', 'list', 'DELETE', 'manage', null, undefined, 0, {}]) {
    assert.equal(levelAllows('full', a), false, `action ${String(a)}`);
    assert.equal(isKeyAction(a), false);
  }
  for (const m of ['', 'admin', 'friends', 'auth', 'fuel ', 'FUEL', '__proto__', 'constructor', null, undefined]) assert.equal(isKeyModule(m), false, `module ${String(m)}`);
});

test('modules offer only the levels that make sense for them', () => {
  assert.deepEqual([...KEY_MODULES], ['vehicle_info', 'vehicle_settings', 'vehicle_create', 'fuel', 'service', 'maintenance', 'notifications', 'statistics']);
  assert.deepEqual(SUPPORTED_LEVELS.vehicle_info, ['none', 'read'], 'vehicle_info is read-only');
  assert.deepEqual(SUPPORTED_LEVELS.statistics, ['none', 'read']);
  assert.ok(!SUPPORTED_LEVELS.notifications.includes('full'), 'notifications have nothing to delete');
  assert.ok(!SUPPORTED_LEVELS.vehicle_settings.includes('read'), 'reading vehicles is vehicle_info');
  for (const m of ['fuel', 'service', 'maintenance'] as const) assert.deepEqual(SUPPORTED_LEVELS[m], [...KEY_LEVELS]);
  assert.deepEqual([...BOOLEAN_MODULES], ['vehicle_create']);
  assert.equal('vehicle_create' in SUPPORTED_LEVELS, false, 'vehicle_create is a boolean, not a level');
  assert.equal(isSupportedLevel('vehicle_create', 'full'), false);
  assert.equal(isSupportedLevel('vehicle_info', 'full'), false);
  assert.equal(isSupportedLevel('vehicle_info', 'read'), true);
  assert.equal(isSupportedLevel('nope', 'read'), false);
});

test('grants are compared per module and fail closed', () => {
  const g = (levels: KeyGrants['levels'], vehicleCreate = false): KeyGrants => ({ levels, vehicleCreate });
  const serviceOnly = g({ vehicle_info: 'read', service: 'read_write' });
  assert.equal(grantsAllow(serviceOnly, { module: 'vehicle_info', action: 'read' }), true);
  assert.equal(grantsAllow(serviceOnly, { module: 'service', action: 'create' }), true);
  assert.equal(grantsAllow(serviceOnly, { module: 'service', action: 'update' }), true);
  assert.equal(grantsAllow(serviceOnly, { module: 'service', action: 'delete' }), false, 'no delete without full');
  assert.equal(grantsAllow(serviceOnly, { module: 'fuel', action: 'read' }), false, 'no module, no access');
  assert.equal(grantsAllow(serviceOnly, { module: 'vehicle_create', action: 'create' }), false);
  assert.equal(grantsAllow(g({}, true), { module: 'vehicle_create', action: 'create' }), true);
  assert.equal(grantsAllow(g({}, true), { module: 'vehicle_create', action: 'read' }), false);
  // A level a module does not offer, or an unknown one, grants nothing.
  assert.equal(grantsAllow(g({ vehicle_info: 'full' }), { module: 'vehicle_info', action: 'read' }), false);
  assert.equal(grantsAllow(g({ fuel: 'superuser' as never }), { module: 'fuel', action: 'read' }), false);
  assert.equal(grantsAllow(g({ fuel: 'full' }), { module: 'bogus' as never, action: 'read' }), false);
  assert.equal(grantsAllow(g({ fuel: 'full' }), { module: 'fuel', action: 'bogus' as never }), false);
  assert.equal(grantsAllow(g({ fuel: 'full' }), { module: 'vehicle_info', action: 'delete' as never }), false);
  // Statistics need the source module as well.
  const stats = KEY_ROUTE_POLICIES['GET /v1/vehicles/:vehicleId/stats'] as KeyRule;
  assert.equal(rulePermits(g({ statistics: 'read' }), stats), false);
  assert.equal(rulePermits(g({ statistics: 'read', fuel: 'read' }), stats), true);
  assert.equal(rulePermits(g({ fuel: 'full' }), stats), false);
});
