// HTTP routes for fuel records and statistics. Authorization lives in FuelService.
import type { HttpRequest, Route } from '../http/app.ts';
import { instant, invalid } from '../http/validate.ts';
import { requirePrincipal } from '../identity.ts';
import type { Window } from './economy.ts';
import type { FuelService } from './service.ts';

/** `from` inclusive, `to` exclusive; both optional RFC 3339 instants. */
export function windowFromQuery(q: URLSearchParams): Window {
  const from = q.get('from') ? instant(q.get('from'), 'from') : null;
  const to = q.get('to') ? instant(q.get('to'), 'to') : null;
  if (from && to && from >= to) throw invalid('from must be before to.');
  return { from, to };
}

function int(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null) return undefined;
  if (!/^\d{1,6}$/.test(v)) throw invalid(`${name} must be a non-negative integer.`);
  return Number(v);
}

export function fuelRoutes(svc: FuelService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const base = '/v1/vehicles/:vehicleId/fill-ups';
  return [
    { method: 'GET', path: base, async handler(r) {
      const opts: { limit?: number; offset?: number } = {};
      const limit = int(r.query, 'limit'), offset = int(r.query, 'offset');
      if (limit !== undefined) opts.limit = limit;
      if (offset !== undefined) opts.offset = offset;
      return { status: 200, body: await svc.list(who(r), r.params['vehicleId'], opts) };
    } },
    { method: 'POST', path: base, async handler(r) { return { status: 201, body: await svc.create(who(r), r.params['vehicleId'], r.body) }; } },
    { method: 'GET', path: `${base}/:fillUpId`, async handler(r) { return { status: 200, body: await svc.get(who(r), r.params['vehicleId'], r.params['fillUpId']) }; } },
    { method: 'PATCH', path: `${base}/:fillUpId`, async handler(r) { return { status: 200, body: await svc.update(who(r), r.params['vehicleId'], r.params['fillUpId'], r.body) }; } },
    { method: 'DELETE', path: `${base}/:fillUpId`, async handler(r) { await svc.remove(who(r), r.params['vehicleId'], r.params['fillUpId']); return { status: 204 }; } },
    { method: 'GET', path: '/v1/vehicles/:vehicleId/stats', async handler(r) { return { status: 200, body: await svc.stats(who(r), r.params['vehicleId'], windowFromQuery(r.query)) }; } },
  ];
}
