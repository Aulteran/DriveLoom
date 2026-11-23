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
import { ServiceService } from './service/service.ts';
import { serviceRoutes } from './service/routes.ts';
import { MaintenanceService } from './service/maintenance.ts';
import { maintenanceRoutes } from './service/maintenance-routes.ts';
import { AttachmentService, attachmentRoutes } from './service/attachments.ts';
import { NotificationSettingsService, notificationRoutes } from './service/notification-settings.ts';
import type { Notifier } from './service/notifications.ts';
import { preferenceRoutes } from './preferences.ts';
import { vehiclePrefRoutes } from './modules.ts';
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

/** Requests that can change a vehicle's latest known odometer, after which reminders are evaluated again. */
const ODOMETER_WRITES = new Set(['POST /v1/vehicles/:vehicleId/fill-ups', 'PATCH /v1/vehicles/:vehicleId/fill-ups/:fillUpId',
  'POST /v1/vehicles/:vehicleId/service-visits', 'PATCH /v1/vehicles/:vehicleId/service-visits/:visitId']);

/**
 * Wraps the odometer-changing routes so a successful (committed) write asks the
 * notifier to look at that vehicle again. Fire and forget: the response never
 * waits for it and cannot fail because of it.
 */
export function withOdometerTrigger(routes: Route[], notifier: Pick<Notifier, 'afterOdometerChange'>): Route[] {
  return routes.map((r) => (!ODOMETER_WRITES.has(`${r.method} ${r.path}`) ? r : {
    ...r,
    async handler(req) {
      const res = await r.handler(req);
      const id = req.params['vehicleId'];
      const body = req.body as Record<string, unknown> | null | undefined;
      // A visit only matters when it carries an odometer; a fill-up always does.
      const relevant = !r.path.includes('service-visits') || (body !== null && typeof body === 'object' && body['odometer'] !== undefined && body['odometer'] !== null);
      if (res.status < 300 && relevant && typeof id === 'string') {
        try { notifier.afterOdometerChange(id as never); } catch { /* never fails the request */ }
      }
      return res;
    },
  }));
}

export function allRoutes(ctx: AuthContext, notifier: Notifier | null = null): Route[] {
  const vehicles = new VehicleService(ctx.db);
  const fuel = new FuelService(ctx.db, vehicles, ctx.now);
  const service = new ServiceService(ctx.db, vehicles, ctx.now);
  const routes = [
    ...systemRoutes(ctx.db),
    ...authRoutes(ctx),
    ...adminRoutes(ctx),
    ...vehicleRoutes(vehicles),
    ...imageRoutes(ctx.db, vehicles),
    ...vehiclePrefRoutes(ctx.db),
    ...fuelRoutes(fuel),
    ...serviceRoutes(service),
    ...attachmentRoutes(new AttachmentService(ctx.db, vehicles)),
    ...maintenanceRoutes(new MaintenanceService(ctx.db, vehicles, ctx.now)),
    ...notificationRoutes(new NotificationSettingsService(ctx.db, vehicles, () => !!ctx.mailer)),
    ...preferenceRoutes(ctx.db),
    ...friendRoutes(new FriendService(ctx.db, vehicles, fuel, ctx.now)),
    ...portabilityRoutes(new PortabilityService(ctx.db, vehicles, fuel, service, ctx.now)),
  ];
  return notifier ? withOdometerTrigger(routes, notifier) : routes;
}

export interface ApplicationOptions {
  /** Directory of the built web client; null serves the API only. */
  webDir: string | null;
  /** Maintenance email reminders; when given, fill-ups and visits with an odometer trigger an evaluation. */
  notifier?: Notifier | null;
}

export function createApplication(ctx: AuthContext, opts: ApplicationOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const api = createApp({ routes: allRoutes(ctx, opts.notifier ?? null), authenticator: authenticator(ctx), publicOrigin: ctx.config.publicOrigin, ipTrust: ctx.config.ipTrust });
  const web = opts.webDir ? staticFiles(opts.webDir, { secure: ctx.config.secureCookies }) : null;
  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/v1' || path.startsWith('/v1/') || !web) return api(req, res);
    return web(req, res);
  };
}
