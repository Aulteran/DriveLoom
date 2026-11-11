// Identity and authorization interface shared by every API milestone.
// Owned by the auth lane (milestone 1.2); other lanes depend on this file and
// on the `users` table only. See "Identity and authorization interface" in
// docs/CONTRACTS.md before changing anything here (changes are a contract change).
import type { Id } from './types.ts';

/** Instance-level role. Not a vehicle role: admins get no routine vehicle access. */
export type InstanceRole = 'admin' | 'user';

/** The authenticated caller of a request, produced only by the auth module. */
export interface Principal {
  readonly userId: Id;
  readonly sessionId: Id;
  readonly instanceRole: InstanceRole;
  /** When the session last completed a full sign-in (for reauthentication checks). */
  readonly authenticatedAt: Date;
}

/** Per-request context handed to every route handler. `principal` is null for anonymous callers. */
export interface RequestContext {
  readonly principal: Principal | null;
}

/** Stable problem codes the auth layer raises; mapped to RFC 9457 problems by the HTTP layer. */
export type AuthProblemCode = 'unauthenticated' | 'forbidden' | 'csrf_failed' | 'reauth_required';

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

/** Only for instance-administration routes (user management, recovery). Never use it to read vehicle data. */
export function requireInstanceAdmin(ctx: RequestContext): Principal {
  const p = requirePrincipal(ctx);
  if (p.instanceRole !== 'admin') throw new AuthError('forbidden');
  return p;
}

/** Authorization failures for resources the caller may not see use 404, not 403, to avoid existence leaks. */
export const NOT_FOUND_FOR_UNAUTHORIZED = true as const;
