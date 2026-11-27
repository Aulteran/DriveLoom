// GET /v1/me: who am I and how am I authenticated. The one endpoint open to a session and to any valid key alike
// (policy 'any_key'), so a script can check that its key works and what it may do. Deliberately minimal: no email,
// no roles, no vehicle names. For a key it reports its configuration, not what the owner could do with a session.
import type { Route } from '../http/app.ts';
import { requirePrincipal } from '../identity.ts';
import type { AuthContext } from './context.ts';
import { LEVEL_MODULES, type KeyLevel, type LevelModule } from './api-key-policy.ts';

export function meRoutes(ctx: AuthContext): Route[] {
  return [
    { method: 'GET', path: '/v1/me', async handler(req) {
      const p = requirePrincipal(req.ctx);
      const { rows } = await ctx.db.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [p.userId]);
      const user = { id: p.userId, displayName: rows[0]?.display_name ?? '' };
      if (p.kind === 'session') return { status: 200, body: { user, authMethod: 'session', apiKey: null } };
      const permissions: Partial<Record<LevelModule, KeyLevel>> = {};
      for (const m of LEVEL_MODULES) { const l = p.apiKey.grants.levels[m]; if (l !== undefined && l !== 'none') permissions[m] = l; }
      return {
        status: 200,
        body: {
          user, authMethod: 'api_key',
          apiKey: {
            id: p.apiKey.id, name: p.apiKey.name, permissions, vehicleMode: p.apiKey.vehicleMode,
            vehicleIds: [...p.apiKey.vehicleIds].sort(), vehicleCreate: p.apiKey.grants.vehicleCreate, expiresAt: p.apiKey.expiresAt?.toISOString() ?? null,
          },
        },
      };
    } },
  ];
}
