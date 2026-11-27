// Bearer authentication and central authorization for API keys. The router (http/app.ts) calls the gate once
// per request that presents a credential; everything a key may do is decided here, from the route's declared
// policy (api-key-route-policies.ts), before any handler or body parser runs:
//
//   1. count failures per trusted client IP: past the limit a failing attempt is 429 instead of 401. A valid key is never
//      blocked by someone else's failures (behind a misconfigured proxy every client shares one address),
//   2. resolve the token by hash (active owner, not revoked or expired, instance switch on),
//   3. count the request against the key's rate limit and record use,
//   4. route policy: session-only, pending, optional and unknown routes are refused; a rule whose run-time effects
//      are not enforced yet is refused; a vehicle outside the key's scope is the ordinary 404; a missing grant is 403.
//
// Run-time effects that depend on the request body or stored data (nested deletes, task links, preset effects,
// redaction) are enforced where the data is available, with requireKeyGrant (below). Writes re-check the key
// inside their transaction (recheckKeyInTx), so a revocation or a scope reduction cannot be outrun by a request
// already in flight.
import type pg from 'pg';
import { HttpProblem } from '../http/problem.ts';
import type { ApiKeyGate } from '../http/app.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { ApiKeyPrincipal, Principal } from '../identity.ts';
import type { Id } from '../types.ts';
import { rateLimit, type AuthContext } from './context.ts';
import { grantsAllow, rulePermits, ENFORCED_DYNAMIC, type KeyGrants, type KeyRequirement, type KeyRule } from './api-key-policy.ts';
import { keyPolicyOf } from './api-key-route-policies.ts';
import { grantsFromStored, lookupApiKey, touchApiKeyUsed } from './api-keys.ts';

/** Defaults: failed bearer attempts per client IP per minute; requests per key per minute; uploads, imports and exports per key per minute. */
export const API_KEY_LIMITS = { failuresPerIpPerMinute: 20, perKeyPerMinute: 300, heavyPerKeyPerMinute: 30 } as const;
const WINDOW_MS = 60_000;

export const apiKeyProblems = {
  invalid: () => new HttpProblem(401, 'invalid_api_key', 'Invalid API key', 'The API key is missing, malformed, expired or revoked.', {}, { 'www-authenticate': 'Bearer error="invalid_token"' }),
  notAllowed: (detail = 'This endpoint cannot be used with an API key. Sign in to the web app instead.') => new HttpProblem(403, 'api_key_not_allowed', 'API keys cannot use this endpoint', detail),
  disabled: () => new HttpProblem(403, 'api_keys_disabled', 'API keys are disabled', 'An administrator has turned API keys off for this instance.'),
  httpsRequired: () => new HttpProblem(403, 'https_required', 'HTTPS required', 'API keys are only accepted over HTTPS (or from the local machine). Use the https:// address of this server.'),
  scope: (req: KeyRequirement) => new HttpProblem(403, 'insufficient_scope', 'Insufficient scope', `This API key does not allow this operation. Required: ${req.module}.${req.action}.`, { required: `${req.module}.${req.action}` }),
  vehicleNotFound: () => new HttpProblem(404, 'vehicle_not_found', 'Vehicle not found'),
};

const requestIdOf = (raw: string | null): string => (raw !== null && /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : uuidv7());

export function createApiKeyGate(ctx: AuthContext, limits: Partial<{ -readonly [K in keyof typeof API_KEY_LIMITS]: number }> = {}): ApiKeyGate {
  const lim = { ...API_KEY_LIMITS, ...limits };
  const fail = async (ip: string): Promise<never> => {
    await rateLimit(ctx, `apikey-fail:ip:${ip}`, lim.failuresPerIpPerMinute, WINDOW_MS);
    throw apiKeyProblems.invalid();
  };
  return {
    async authenticate({ token, ip, route, params, requestId }): Promise<ApiKeyPrincipal> {
      if (token === null) return fail(ip);
      const found = await lookupApiKey(ctx, token);
      if (!found.ok) {
        // Reaching instance_disabled means the token is otherwise valid: tell its holder why it is refused. Every other reason is one generic 401.
        if (found.reason === 'instance_disabled') throw apiKeyProblems.disabled();
        return fail(ip);
      }
      const k = found.key;
      const policy = keyPolicyOf(route);
      const rule: KeyRule | null = typeof policy === 'object' ? policy : null;
      const heavy = route.rawBody !== undefined || (rule?.dynamic ?? []).includes('payload_sections');
      await rateLimit(ctx, heavy ? `apikey:${k.id}:heavy` : `apikey:${k.id}`, heavy ? lim.heavyPerKeyPerMinute : lim.perKeyPerMinute, WINDOW_MS);
      await touchApiKeyUsed(ctx, k.id);
      const principal: ApiKeyPrincipal = {
        kind: 'api_key', userId: k.userId, instanceRole: 'user',
        apiKey: { id: k.id, name: k.name, grants: k.grants, vehicleMode: k.vehicleMode, vehicleIds: k.vehicleIds, expiresAt: k.expiresAt, rule, requestId: requestIdOf(requestId), checkedAt: ctx.now() },
      };
      // Only 'required' routes with an affirmative key policy are reachable; pending, optional, session-only, public-with-auth and undeclared routes are not.
      if ((route.auth ?? 'required') !== 'required' || (policy !== 'any_key' && rule === null)) throw apiKeyProblems.notAllowed();
      if (rule) {
        if ((rule.dynamic ?? []).some((d) => !ENFORCED_DYNAMIC.has(d))) throw apiKeyProblems.notAllowed('This endpoint is not available to API keys yet.');
        // Vehicle first: outside the key's scope it is the ordinary "not found", before any grant is mentioned.
        if (route.path.includes(':vehicleId') && !(await vehicleInKeyScope(ctx.db, principal, params['vehicleId']))) throw apiKeyProblems.vehicleNotFound();
        const missing = [rule, ...(rule.also ?? [])].find((r) => !grantsAllow(k.grants, r));
        if (missing) throw apiKeyProblems.scope(missing);
      }
      return principal;
    },
  };
}

/** Vehicles the key's stored selection names, or null when the mode is all_current_future (no stored list). */
export function keyStoredVehicleIds(p: ApiKeyPrincipal): Id[] | null {
  return p.apiKey.vehicleMode === 'all_current_future' ? null : [...p.apiKey.vehicleIds];
}

/** The selection half of scope, without a database round trip: sessions are unrestricted; a key needs the vehicle in its selection (or all_current_future). Membership is checked separately. */
export function keySelectionAllows(p: Principal, vehicleId: Id): boolean {
  if (p.kind !== 'api_key') return true;
  return p.apiKey.vehicleMode === 'all_current_future' || p.apiKey.vehicleIds.has(vehicleId);
}

/** In scope = in the key's selection (stored ids for selected / all_current; any for all_current_future) AND the owner is a member right now. */
export async function vehicleInKeyScope(db: Pick<pg.Pool, 'query'>, p: ApiKeyPrincipal, vehicleId: unknown): Promise<boolean> {
  if (!isUuid(vehicleId)) return false;
  const stored = keyStoredVehicleIds(p);
  if (stored !== null && !stored.includes(vehicleId)) return false;
  return ((await db.query('SELECT 1 FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [vehicleId, p.userId])).rowCount ?? 0) > 0;
}

/**
 * Run-time grant check for effects the route's static rule cannot express. Sessions are unaffected (their
 * authority is the vehicle role); for a key a missing grant is 403 insufficient_scope. Unknown input is denied.
 */
export function requireKeyGrant(p: Principal, req: KeyRequirement): void {
  if (p.kind !== 'api_key') return;
  if (!grantsAllow(p.apiKey.grants, req)) throw apiKeyProblems.scope(req);
}

/**
 * Inside a write transaction (after the vehicle row is locked): the key must still be active, its owner active, the instance
 * switch on, the vehicle still in its selection, and its grants still cover the route. Closes the window between the
 * router's check and the commit. Returns the key's CURRENT grants (null for a session) so run-time effects can be checked
 * against them. `vehicleId` null: there is no vehicle yet (creating one), so the selection is not checked. Sessions are a no-op.
 */
export async function recheckKeyInTx(q: Pick<pg.Pool, 'query'>, p: Principal, vehicleId: Id | null): Promise<KeyGrants | null> {
  if (p.kind !== 'api_key') return null;
  const { rows } = await q.query<{ mode: string; allow_create: boolean; active: boolean; user_active: boolean; enabled: boolean; selected: boolean; perms: Record<string, string> }>(
    `SELECT k.vehicle_mode AS mode, k.allow_vehicle_create AS allow_create,
            (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > $2)) AS active,
            u.status = 'active' AS user_active,
            COALESCE((SELECT f.enabled FROM instance_flags f WHERE f.flag = 'api_keys'), true) AS enabled,
            EXISTS (SELECT 1 FROM api_key_vehicles v WHERE v.key_id = k.id AND v.vehicle_id = $3) AS selected,
            COALESCE((SELECT jsonb_object_agg(pm.module, pm.level) FROM api_key_permissions pm WHERE pm.key_id = k.id), '{}'::jsonb) AS perms
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = $1 AND k.user_id = $4`,
    [p.apiKey.id, p.apiKey.checkedAt, vehicleId, p.userId]);
  const r = rows[0];
  if (!r || !r.active || !r.user_active) throw apiKeyProblems.invalid();
  if (!r.enabled) throw apiKeyProblems.disabled();
  if (vehicleId !== null && r.mode !== 'all_current_future' && !r.selected) throw apiKeyProblems.vehicleNotFound();
  const grants = grantsFromStored(r.perms, r.allow_create);
  const rule = p.apiKey.rule;
  if (rule && !rulePermits(grants, rule)) throw apiKeyProblems.scope([rule, ...(rule.also ?? [])].find((x) => !grantsAllow(grants, x)) ?? rule);
  return grants;
}

