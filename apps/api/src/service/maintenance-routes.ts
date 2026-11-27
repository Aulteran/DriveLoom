// HTTP routes for maintenance planning. Module gate and authorization live in MaintenanceService.
import { idemFrom, idemHeaders } from '../auth/idempotency.ts';
import type { HttpRequest, Route } from '../http/app.ts';
import { invalid } from '../http/validate.ts';
import { requirePrincipal } from '../identity.ts';
import type { MaintenanceService } from './maintenance.ts';

export function maintenanceRoutes(svc: MaintenanceService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const base = '/v1/vehicles/:vehicleId/maintenance-tasks';
  const presets = '/v1/vehicles/:vehicleId/maintenance/presets';
  const scope = (r: HttpRequest) => r.query.get('scope') ?? undefined;
  return [
    { method: 'GET', path: '/v1/maintenance-catalog', async handler(r) { return { status: 200, body: await svc.catalog(who(r)) }; } },
    { method: 'GET', path: '/v1/vehicles/:vehicleId/maintenance-status', async handler(r) { return { status: 200, body: await svc.summary(who(r), r.params['vehicleId']) }; } },
    { method: 'GET', path: base, async handler(r) {
      const a = r.query.get('includeArchived');
      if (a !== null && a !== 'true' && a !== 'false') throw invalid('includeArchived must be true or false.');
      return { status: 200, body: await svc.list(who(r), r.params['vehicleId'], { includeArchived: a === 'true' }) };
    } },
    { method: 'POST', path: base, async handler(r) {
      const idem = idemFrom(r.headers, who(r));
      const body = await svc.create(who(r), r.params['vehicleId'], r.body, idem);
      return { status: idem.status ?? 201, body, headers: idemHeaders(idem) };
    } },
    { method: 'GET', path: `${base}/:taskId`, async handler(r) { return { status: 200, body: await svc.get(who(r), r.params['vehicleId'], r.params['taskId']) }; } },
    { method: 'PATCH', path: `${base}/:taskId`, async handler(r) { return { status: 200, body: await svc.update(who(r), r.params['vehicleId'], r.params['taskId'], r.body) }; } },
    { method: 'DELETE', path: `${base}/:taskId`, async handler(r) { await svc.remove(who(r), r.params['vehicleId'], r.params['taskId']); return { status: 204 }; } },
    { method: 'PUT', path: `${base}/:taskId/snooze`, async handler(r) { return { status: 200, body: await svc.setSnooze(who(r), r.params['vehicleId'], r.params['taskId'], scope(r), r.body) }; } },
    { method: 'DELETE', path: `${base}/:taskId/snooze`, async handler(r) { return { status: 200, body: await svc.clearSnooze(who(r), r.params['vehicleId'], r.params['taskId'], scope(r)) }; } },
    { method: 'GET', path: presets, async handler(r) { return { status: 200, body: await svc.presets(who(r), r.params['vehicleId'], r.query.get('market') ?? undefined) }; } },
    { method: 'POST', path: `${presets}/:presetId/apply`, async handler(r) {
      const pv = r.query.get('preview');
      if (pv !== null && pv !== 'true' && pv !== 'false') throw invalid('preview must be true or false.');
      return { status: 200, body: await svc.applyPreset(who(r), r.params['vehicleId'], r.params['presetId'], r.body, pv === 'true') };
    } },
  ];
}
