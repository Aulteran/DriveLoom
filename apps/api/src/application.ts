// Composition root: every module's routes, one HTTP handler for the API and
// the web client. server.ts (the process) and the end-to-end tests both build
// the application here, so what is tested is what runs.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { createApp, type Route } from './http/app.ts';
import { authenticator } from './auth/sessions.ts';
import { authRoutes } from './auth/routes.ts';
import type { AuthContext } from './auth/context.ts';
import { adminRoutes } from './admin/routes.ts';
import { VehicleService } from './vehicles/service.ts';
import { vehicleRoutes } from './vehicles/routes.ts';
import { imageRoutes } from './vehicles/images.ts';
import { FuelService } from './fuel/service.ts';
import { fuelRoutes } from './fuel/routes.ts';
import { preferenceRoutes } from './preferences.ts';
import { FriendService } from './friends/service.ts';
import { friendRoutes } from './friends/routes.ts';
import { PortabilityService } from './portability/service.ts';
import { portabilityRoutes } from './portability/routes.ts';
import { staticFiles } from './http/static.ts';
import { API_VERSION } from './version.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const SERVER_VERSION = pkg.version;

export function systemRoutes(pool: pg.Pool): Route[] {
  return [
    { method: 'GET', path: '/v1/health', auth: 'none', handler: async () => { await pool.query('SELECT 1'); return { status: 200, body: { status: 'ok', database: 'ok' } }; } },
    { method: 'GET', path: '/v1/version', auth: 'none', handler: async () => {
      const { rows } = await pool.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
      return { status: 200, body: { server: SERVER_VERSION, api: API_VERSION, schema: rows[0]!.v ?? 0 } };
    } },
  ];
}

export function allRoutes(ctx: AuthContext): Route[] {
  const vehicles = new VehicleService(ctx.db);
  const fuel = new FuelService(ctx.db, vehicles, ctx.now);
  return [
    ...systemRoutes(ctx.db),
    ...authRoutes(ctx),
    ...adminRoutes(ctx),
    ...vehicleRoutes(vehicles),
    ...imageRoutes(ctx.db, vehicles),
    ...fuelRoutes(fuel),
    ...preferenceRoutes(ctx.db),
    ...friendRoutes(new FriendService(ctx.db, vehicles, fuel, ctx.now)),
    ...portabilityRoutes(new PortabilityService(ctx.db, vehicles, fuel, ctx.now)),
  ];
}

export interface ApplicationOptions {
  /** Directory of the built web client; null serves the API only. */
  webDir: string | null;
}

export function createApplication(ctx: AuthContext, opts: ApplicationOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const api = createApp({ routes: allRoutes(ctx), authenticator: authenticator(ctx), publicOrigin: ctx.config.publicOrigin, ipTrust: ctx.config.ipTrust });
  const web = opts.webDir ? staticFiles(opts.webDir, { secure: ctx.config.secureCookies }) : null;
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/v1' || path.startsWith('/v1/') || !web) return api(req, res);
    return web(req, res);
  };
}
