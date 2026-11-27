// Identity and authorization interface shared by every API milestone.
// Owned by the auth lane (milestone 1.2); other lanes depend on this file and
// on the `users` table only. Treat any change here as an API contract change.
import type { Id } from './types.ts';
import type { KeyGrants, KeyRule } from './auth/api-key-policy.ts';

/** Instance-level role. Not a vehicle role: admins get no routine vehicle access. */
export type InstanceRole = 'admin' | 'user';

/** A browser or app session: cookie + CSRF, and the only principal that can pass fresh-authentication checks. */
export interface SessionPrincipal {
  readonly kind: 'session';
  readonly userId: Id;
  readonly sessionId: Id;
  readonly instanceRole: InstanceRole;
  /** When the session last completed a full sign-in (for reauthentication checks). */
  readonly authenticatedAt: Date;
}

/** Vehicle selection modes of a key (see auth/api-keys.ts). */
export type KeyVehicleMode = 'selected' | 'all_current' | 'all_current_future';

/**
 * A personal API key acting for its owner. It carries only what the key was configured with; rights are
 * still intersected with the owner's live vehicle roles. It has no session, no CSRF token and no
 * sign-in time, so it can never satisfy a fresh-authentication check, and it is never an instance admin.
 */
export interface ApiKeyPrincipal {
  readonly kind: 'api_key';
  readonly userId: Id;
  /** Always 'user': a key never acts as an instance administrator, whatever its owner is. */
  readonly instanceRole: 'user';
  readonly apiKey: {
    readonly id: Id;
    readonly name: string;
    readonly grants: KeyGrants;
    readonly vehicleMode: KeyVehicleMode;
    /** Stored snapshot for selected / all_current; empty for all_current_future. Membership is checked live per request. */
    readonly vehicleIds: ReadonlySet<Id>;
    readonly expiresAt: Date | null;
    /** The rule of the route being served (null for GET /v1/me); re-checked inside write transactions. */
    readonly rule: KeyRule | null;
    /** Correlation id of this request (X-Request-Id when well formed, else generated). */
    readonly requestId: string;
    /** The clock reading used to authenticate this request. */
    readonly checkedAt: Date;
  };
}

/** The authenticated caller of a request, produced only by the auth module. */
export type Principal = SessionPrincipal | ApiKeyPrincipal;

/** Per-request context handed to every route handler. `principal` is null for anonymous callers. */
export interface RequestContext {
  readonly principal: Principal | null;
}

/** Stable problem codes the auth layer raises; mapped to RFC 9457 problems by the HTTP layer. */
export type AuthProblemCode = 'unauthenticated' | 'forbidden' | 'csrf_failed' | 'reauth_required' | 'api_key_not_allowed';

export class AuthError extends Error {
  readonly code: AuthProblemCode;
  readonly status: 401 | 403;
  constructor(code: AuthProblemCode, message: string = code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = code === 'unauthenticated' ? 401 : 403;
  }
}

/** Every authenticated route starts here. Throws AuthError('unauthenticated') for anonymous callers. */
export function requirePrincipal(ctx: RequestContext): Principal {
  if (!ctx.principal) throw new AuthError('unauthenticated');
  return ctx.principal;
}

/** For session-only routes: a key principal is refused (403 api_key_not_allowed), whatever the route policy says. */
export function requireSessionPrincipal(ctx: RequestContext): SessionPrincipal {
  const p = requirePrincipal(ctx);
  if (p.kind !== 'session') throw new AuthError('api_key_not_allowed');
  return p;
}

/** Only for instance-administration routes (user management, recovery). Never use it to read vehicle data. Sessions only. */
export function requireInstanceAdmin(ctx: RequestContext): SessionPrincipal {
  const p = requireSessionPrincipal(ctx);
  if (p.instanceRole !== 'admin') throw new AuthError('forbidden');
  return p;
}

/** Authorization failures for resources the caller may not see use 404, not 403, to avoid existence leaks. */
export const NOT_FOUND_FOR_UNAUTHORIZED = true as const;
