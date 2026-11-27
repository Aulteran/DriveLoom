// HTTP routes for service history. Module gate and authorization live in ServiceService.
import { idemFrom, idemHeaders } from '../auth/idempotency.ts';
import type { HttpRequest, Route } from '../http/app.ts';
import { invalid } from '../http/validate.ts';
import { requirePrincipal } from '../identity.ts';
import type { ServiceService } from './service.ts';

export function serviceRoutes(svc: ServiceService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const base = '/v1/vehicles/:vehicleId/service-visits';
  return [
    { method: 'GET', path: base, async handler(r) {
      const o: Parameters<ServiceService['list']>[2] = {};
      const limit = r.query.get('limit');
      if (limit !== null) { if (!/^\d{1,3}$/.test(limit)) throw invalid('limit must be a positive integer.'); o.limit = Number(limit); }
      for (const k of ['cursor', 'from', 'to', 'q', 'category'] as const) { const v = r.query.get(k); if (v !== null) o[k] = v; }
      return { status: 200, body: await svc.list(who(r), r.params['vehicleId'], o) };
    } },
    { method: 'POST', path: base, async handler(r) {
      const idem = idemFrom(r.headers, who(r));
      const body = await svc.create(who(r), r.params['vehicleId'], r.body, idem);
      return { status: idem.status ?? 201, body, headers: idemHeaders(idem) };
    } },
    { method: 'GET', path: `${base}/:visitId`, async handler(r) { return { status: 200, body: await svc.get(who(r), r.params['vehicleId'], r.params['visitId']) }; } },
    { method: 'PATCH', path: `${base}/:visitId`, async handler(r) { return { status: 200, body: await svc.update(who(r), r.params['vehicleId'], r.params['visitId'], r.body) }; } },
    { method: 'DELETE', path: `${base}/:visitId`, async handler(r) { await svc.remove(who(r), r.params['vehicleId'], r.params['visitId']); return { status: 204 }; } },
  ];
}
