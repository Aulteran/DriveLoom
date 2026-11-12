// HTTP routes for vehicle export and import. Authorization lives in PortabilityService.
import type { HttpRequest, Route } from '../http/app.ts';
import { requirePrincipal } from '../identity.ts';
import { MAX_IMPORT_BYTES, type PortabilityService } from './service.ts';

export function portabilityRoutes(svc: PortabilityService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  return [
    { method: 'GET', path: '/v1/vehicles/:vehicleId/export', async handler(r) {
      const out = await svc.exportVehicle(who(r), r.params['vehicleId'], r.query.get('format'));
      return { status: 200, raw: { data: out.data, contentType: out.contentType }, headers: { 'content-disposition': `attachment; filename="${out.filename}"` } };
    } },
    { method: 'POST', path: '/v1/vehicles/:vehicleId/import', maxBodyBytes: MAX_IMPORT_BYTES, async handler(r) {
      return { status: 200, body: await svc.importInto(who(r), r.params['vehicleId'], r.body) };
    } },
    { method: 'POST', path: '/v1/vehicle-imports', maxBodyBytes: MAX_IMPORT_BYTES, async handler(r) {
      return { status: 200, body: await svc.importNew(who(r), r.body) };
    } },
  ];
}
