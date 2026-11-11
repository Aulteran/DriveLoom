// HTTP routes for vehicles and ownership. All authorization lives in VehicleService.
import type { HttpRequest, Route } from '../http/app.ts';
import { requirePrincipal } from '../identity.ts';
import { invalid } from './errors.ts';
import type { VehicleService } from './service.ts';

/** Body must be a JSON object containing only the allowed keys (schemas use additionalProperties: false). */
function obj(body: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Request body must be a JSON object.');
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(`Unknown field: ${extra[0]}.`);
  return body as Record<string, unknown>;
}

export function vehicleRoutes(svc: VehicleService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const fields = ['name', 'make', 'model', 'year'];
  return [
    { method: 'GET', path: '/v1/vehicles', async handler(r) {
      const items = await svc.list(who(r), { includeArchived: r.query.get('includeArchived') === 'true' });
      return { status: 200, body: { items } };
    } },
    { method: 'POST', path: '/v1/vehicles', async handler(r) {
      const p = who(r);
      return { status: 201, body: await svc.create(p, obj(r.body, fields) as never) };
    } },
    { method: 'GET', path: '/v1/vehicles/:vehicleId', async handler(r) {
      return { status: 200, body: await svc.get(who(r), r.params['vehicleId']) };
    } },
    { method: 'PATCH', path: '/v1/vehicles/:vehicleId', async handler(r) {
      const p = who(r);
      const patch = obj(r.body, fields);
      if (!Object.keys(patch).length) throw invalid('At least one field is required.');
      return { status: 200, body: await svc.update(p, r.params['vehicleId'], patch) };
    } },
    { method: 'PUT', path: '/v1/vehicles/:vehicleId/archive', async handler(r) {
      const p = who(r);
      const { archived } = obj(r.body, ['archived']);
      if (typeof archived !== 'boolean') throw invalid('archived must be a boolean.');
      return { status: 200, body: await svc.setArchived(p, r.params['vehicleId'], archived) };
    } },
    { method: 'GET', path: '/v1/vehicles/:vehicleId/members', async handler(r) {
      return { status: 200, body: { items: await svc.listMembers(who(r), r.params['vehicleId']) } };
    } },
    { method: 'POST', path: '/v1/vehicles/:vehicleId/members', async handler(r) {
      const p = who(r);
      const b = obj(r.body, ['userId', 'role']);
      return { status: 201, body: await svc.addMember(p, r.params['vehicleId'], b['userId'], b['role']) };
    } },
    { method: 'PUT', path: '/v1/vehicles/:vehicleId/members/:userId', async handler(r) {
      const p = who(r);
      const b = obj(r.body, ['role']);
      return { status: 200, body: await svc.changeMemberRole(p, r.params['vehicleId'], r.params['userId'], b['role']) };
    } },
    { method: 'DELETE', path: '/v1/vehicles/:vehicleId/members/:userId', async handler(r) {
      await svc.removeMember(who(r), r.params['vehicleId'], r.params['userId']);
      return { status: 204 };
    } },
    { method: 'PUT', path: '/v1/vehicles/:vehicleId/owner', async handler(r) {
      const p = who(r);
      const b = obj(r.body, ['userId']);
      return { status: 200, body: await svc.transferOwnership(p, r.params['vehicleId'], b['userId']) };
    } },
    { method: 'PUT', path: '/v1/admin/vehicles/:vehicleId/owner', async handler(r) {
      const p = who(r);
      const b = obj(r.body, ['userId', 'reason']);
      await svc.recoverOwnership(p, r.params['vehicleId'], b['userId'], b['reason']);
      return { status: 204 };
    } },
  ];
}
