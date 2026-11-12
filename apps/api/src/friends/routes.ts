// HTTP routes for friends and aggregate comparison. Authorization lives in FriendService.
import type { HttpRequest, Route } from '../http/app.ts';
import { requirePrincipal } from '../identity.ts';
import type { FriendService } from './service.ts';

export function friendRoutes(svc: FriendService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  return [
    { method: 'GET', path: '/v1/friends', async handler(r) { return { status: 200, body: await svc.list(who(r)) }; } },
    { method: 'POST', path: '/v1/friends', async handler(r) { return { status: 200, body: await svc.request(who(r), r.body) }; } },
    { method: 'PUT', path: '/v1/friends/:friendshipId', async handler(r) { await svc.accept(who(r), r.params['friendshipId']); return { status: 204 }; } },
    { method: 'DELETE', path: '/v1/friends/:friendshipId', async handler(r) { await svc.remove(who(r), r.params['friendshipId']); return { status: 204 }; } },
    { method: 'GET', path: '/v1/vehicles/:vehicleId/comparison', async handler(r) { return { status: 200, body: await svc.getOptIn(who(r), r.params['vehicleId']) }; } },
    { method: 'PUT', path: '/v1/vehicles/:vehicleId/comparison', async handler(r) { return { status: 200, body: await svc.setOptIn(who(r), r.params['vehicleId'], r.body) }; } },
    { method: 'GET', path: '/v1/comparisons', async handler(r) { return { status: 200, body: await svc.compare(who(r), r.query.get('window')) }; } },
  ];
}
