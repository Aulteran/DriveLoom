// The one table that says how every route treats API keys. A route is
// identified as "METHOD /v1/path/:param", exactly as registered. Nothing here
// runs yet: bearer authentication arrives later. Until it does, and for any
// route missing from this table, the answer is 'session_only'.
//
// tests/api-key-policy.test.ts enumerates the real router and fails when a
// route has no entry, when an entry matches no route, or when a route the spec
// reserves for sessions is classified as key-accessible. Add the row in the
// same change as the route.
import type { Route } from '../http/app.ts';
import type { KeyDynamic, KeyModule, KeyAction, KeyPolicy, KeyRequirement, KeyRule } from './api-key-policy.ts';

const SESSION = 'session_only' as const;
const PUBLIC = 'public' as const;

function rule(module: KeyModule, action: KeyAction, extra: { also?: KeyRequirement[]; dynamic?: KeyDynamic[] } = {}): KeyRule {
  return Object.freeze({ module, action, ...(extra.also ? { also: Object.freeze(extra.also) } : {}), ...(extra.dynamic ? { dynamic: Object.freeze(extra.dynamic) } : {}) });
}

const V = '/v1/vehicles/:vehicleId';
const VISITS = `${V}/service-visits`;
const TASKS = `${V}/maintenance-tasks`;
const PAYLOAD: KeyDynamic[] = ['payload_sections', 'preview_equals_commit'];

export const KEY_ROUTE_POLICIES: Readonly<Record<string, KeyPolicy>> = Object.freeze({
  // --- public ---
  'GET /v1/health': PUBLIC,
  'GET /v1/version': PUBLIC,

  // --- /v1/auth/*: sessions only, always (sign-in, second factor, credentials, sessions, account, and later key management) ---
  'POST /v1/auth/register': SESSION,
  'POST /v1/auth/verify-email': SESSION,
  'POST /v1/auth/login': SESSION,
  'POST /v1/auth/mfa/totp': SESSION,
  'POST /v1/auth/mfa/email': SESSION,
  'POST /v1/auth/logout': SESSION,
  'GET /v1/auth/session': SESSION,
  'POST /v1/auth/reauth': SESSION,
  'PATCH /v1/auth/account': SESSION,
  'DELETE /v1/auth/account': SESSION,
  'GET /v1/auth/instance': SESSION,
  'GET /v1/auth/sessions': SESSION,
  'DELETE /v1/auth/sessions/:id': SESSION,
  'POST /v1/auth/sessions/revoke-others': SESSION,
  'PUT /v1/auth/password': SESSION,
  'DELETE /v1/auth/password': SESSION,
  'POST /v1/auth/recovery/request': SESSION,
  'POST /v1/auth/recovery/complete': SESSION,
  'POST /v1/auth/totp': SESSION,
  'POST /v1/auth/totp/confirm': SESSION,
  'DELETE /v1/auth/totp': SESSION,
  'POST /v1/auth/passkeys/register/options': SESSION,
  'POST /v1/auth/passkeys/register/verify': SESSION,
  'DELETE /v1/auth/passkeys/:id': SESSION,
  'POST /v1/auth/passkeys/login/options': SESSION,
  'POST /v1/auth/passkeys/login/verify': SESSION,
  'POST /v1/auth/oidc/start': SESSION,
  'GET /v1/auth/oidc/callback': SESSION,
  'DELETE /v1/auth/oidc/identities/:id': SESSION,

  // --- /v1/admin/*: sessions only, always ---
  'GET /v1/admin/users': SESSION,
  'PUT /v1/admin/users/:userId/status': SESSION,
  'PUT /v1/admin/users/:userId/role': SESSION,
  'GET /v1/admin/invites': SESSION,
  'POST /v1/admin/invites': SESSION,
  'DELETE /v1/admin/invites/:inviteId': SESSION,
  'GET /v1/admin/settings/units': SESSION,
  'PUT /v1/admin/settings/units': SESSION,
  'GET /v1/admin/settings/modules': SESSION,
  'PUT /v1/admin/settings/modules/:module': SESSION,
  'GET /v1/admin/settings/smtp': SESSION,
  'PUT /v1/admin/settings/smtp': SESSION,
  'DELETE /v1/admin/settings/smtp': SESSION,
  'POST /v1/admin/settings/smtp/test': SESSION,
  'GET /v1/admin/settings/oidc': SESSION,
  'PUT /v1/admin/settings/oidc': SESSION,
  'DELETE /v1/admin/settings/oidc': SESSION,
  'POST /v1/admin/settings/oidc/test': SESSION,
  'GET /v1/admin/audit': SESSION,
  'PUT /v1/admin/vehicles/:vehicleId/owner': SESSION,
  'GET /v1/admin/users/:userId/owned-vehicles': SESSION,

  // --- vehicles ---
  'GET /v1/vehicle-identities': SESSION, // not in the spec's groups; make/model suggestions only. Could become vehicle_info read.
  'GET /v1/vehicles': rule('vehicle_info', 'read'),
  'POST /v1/vehicles': rule('vehicle_create', 'create'),
  [`GET ${V}`]: rule('vehicle_info', 'read'),
  [`PATCH ${V}`]: rule('vehicle_settings', 'update'),
  [`DELETE ${V}`]: SESSION, // permanent deletion
  [`PUT ${V}/archive`]: SESSION, // archive and unarchive
  [`GET ${V}/members`]: SESSION,
  [`POST ${V}/members`]: SESSION,
  [`PUT ${V}/members/:userId`]: SESSION,
  [`DELETE ${V}/members/:userId`]: SESSION,
  [`PUT ${V}/owner`]: SESSION, // ownership transfer
  [`GET ${V}/image`]: rule('vehicle_info', 'read'),
  [`PUT ${V}/image`]: rule('vehicle_settings', 'update'), // sets or replaces
  [`DELETE ${V}/image`]: rule('vehicle_settings', 'delete'),
  [`GET ${V}/service-visibility`]: SESSION, // a member's own menu preference
  [`PUT ${V}/service-visibility`]: SESSION,

  // --- fuel ---
  [`GET ${V}/fill-ups`]: rule('fuel', 'read'),
  [`POST ${V}/fill-ups`]: rule('fuel', 'create'),
  [`GET ${V}/fill-ups/:fillUpId`]: rule('fuel', 'read'),
  [`PATCH ${V}/fill-ups/:fillUpId`]: rule('fuel', 'update'),
  [`DELETE ${V}/fill-ups/:fillUpId`]: rule('fuel', 'delete'),

  // --- statistics: derived from fill-ups, so both grants are needed ---
  [`GET ${V}/stats`]: rule('statistics', 'read', { also: [{ module: 'fuel', action: 'read' }] }),

  // --- service history and receipts ---
  [`GET ${VISITS}`]: rule('service', 'read'),
  [`POST ${VISITS}`]: rule('service', 'create', { dynamic: ['task_link'] }),
  [`GET ${VISITS}/:visitId`]: rule('service', 'read'),
  [`PATCH ${VISITS}/:visitId`]: rule('service', 'update', { dynamic: ['nested_delete', 'task_link'] }), // `items` replaces the whole list
  [`DELETE ${VISITS}/:visitId`]: rule('service', 'delete'),
  [`POST ${VISITS}/:visitId/attachments`]: rule('service', 'create'),
  [`GET ${VISITS}/:visitId/attachments/:attachmentId`]: rule('service', 'read'),
  [`PATCH ${VISITS}/:visitId/attachments/:attachmentId`]: rule('service', 'update'), // rename
  [`DELETE ${VISITS}/:visitId/attachments/:attachmentId`]: rule('service', 'delete'),

  // --- maintenance ---
  'GET /v1/maintenance-catalog': rule('maintenance', 'read'),
  [`GET ${V}/maintenance-status`]: rule('maintenance', 'read'), // derived from service items and odometer readings; documented, not extra-gated
  [`GET ${TASKS}`]: rule('maintenance', 'read'),
  [`POST ${TASKS}`]: rule('maintenance', 'create'),
  [`GET ${TASKS}/:taskId`]: rule('maintenance', 'read'),
  [`PATCH ${TASKS}/:taskId`]: rule('maintenance', 'update'), // `archived` is a flag, not a removal
  [`DELETE ${TASKS}/:taskId`]: rule('maintenance', 'delete', { dynamic: ['cascade_unlink'] }),
  [`PUT ${TASKS}/:taskId/snooze`]: rule('maintenance', 'update'),
  [`DELETE ${TASKS}/:taskId/snooze`]: rule('maintenance', 'delete'),
  [`GET ${V}/maintenance/presets`]: rule('maintenance', 'read'),
  [`POST ${V}/maintenance/presets/:presetId/apply`]: rule('maintenance', 'create', { dynamic: ['preview_equals_commit', 'preset_effects'] }), // ?preview=true is a dry run

  // --- notifications ---
  [`GET ${V}/notification-settings`]: rule('notifications', 'read', { dynamic: ['redact_members'] }),
  [`PUT ${V}/notification-settings`]: rule('notifications', 'update', { dynamic: ['redact_members'] }),
  [`PUT ${V}/notification-preferences/me`]: rule('notifications', 'update'),

  // --- account-wide and social: sessions only in v1 ---
  'GET /v1/preferences': SESSION,
  'PUT /v1/preferences': SESSION,
  'GET /v1/friends': SESSION,
  'POST /v1/friends': SESSION,
  'PUT /v1/friends/:friendshipId': SESSION,
  'DELETE /v1/friends/:friendshipId': SESSION,
  [`GET ${V}/comparison`]: SESSION,
  [`PUT ${V}/comparison`]: SESSION,
  'GET /v1/comparisons': SESSION,

  // --- portability: the sections actually present decide the permissions ---
  [`GET ${V}/export`]: rule('vehicle_info', 'read', { dynamic: ['payload_sections'] }),
  [`POST ${V}/import`]: rule('vehicle_info', 'read', { dynamic: PAYLOAD }), // dry run by default; commit needs each section's write
  'POST /v1/vehicle-imports': rule('vehicle_create', 'create', { dynamic: PAYLOAD }),
});

const idOf = (r: Pick<Route, 'method' | 'path'>) => `${r.method} ${r.path}`;

/** The declared policy of a route. A route with none declared is session-only. */
export function keyPolicyOf(route: Pick<Route, 'key'>): KeyPolicy {
  return route.key ?? SESSION;
}

/** Attach each route's declared policy as `route.key`. Routes without a table entry are left undeclared. */
export function withKeyPolicies(routes: Route[]): Route[] {
  return routes.map((r) => {
    const key = Object.hasOwn(KEY_ROUTE_POLICIES, idOf(r)) ? KEY_ROUTE_POLICIES[idOf(r)] : undefined;
    return key === undefined ? r : { ...r, key };
  });
}
