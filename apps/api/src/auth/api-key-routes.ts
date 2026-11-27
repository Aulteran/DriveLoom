// HTTP surface of API-key management. Session-only (never callable with a key), CSRF on every mutation, fresh
// authentication where api-keys.ts requires it. Contract: openapi.yaml, tag `auth`. Registered literal-first so
// `revoke-all` is never read as a key id.
import type { HttpRequest, HttpResult, Route } from '../http/app.ts';
import { invalid, obj } from '../http/validate.ts';
import { requirePrincipal } from '../identity.ts';
import { isUuid } from '../ids.ts';
import type { Id } from '../types.ts';
import type { AuthContext } from './context.ts';
import * as keys from './api-keys.ts';

/** Responses that carry a token must never be stored by any cache. */
const NO_STORE = { 'cache-control': 'no-store' };
const requestId = (req: HttpRequest): string | null => {
  const v = req.headers['x-request-id'];
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null;
};

export function apiKeyRoutes(ctx: AuthContext): Route[] {
  const me = (req: HttpRequest) => requirePrincipal(req.ctx);
  return [
    { method: 'GET', path: '/v1/auth/api-keys', async handler(req) {
      return { status: 200, body: await keys.listApiKeys(ctx, me(req).userId) };
    } },
    { method: 'POST', path: '/v1/auth/api-keys', async handler(req) {
      const p = me(req);
      const out = await keys.createApiKey(ctx, p, keys.parseCreateInput(req.body), requestId(req));
      return { status: 201, body: { ...out.key, token: out.token }, headers: NO_STORE } satisfies HttpResult;
    } },
    { method: 'POST', path: '/v1/auth/api-keys/revoke-all', async handler(req) {
      obj(req.body ?? {}, []);
      return { status: 200, body: { revoked: await keys.revokeAllApiKeys(ctx, me(req), requestId(req)) } };
    } },
    { method: 'PATCH', path: '/v1/auth/api-keys/:id', async handler(req) {
      const p = me(req);
      return { status: 200, body: await keys.updateApiKey(ctx, p, req.params['id'], keys.parsePatchInput(req.body), requestId(req)) };
    } },
    { method: 'DELETE', path: '/v1/auth/api-keys/:id', async handler(req) {
      await keys.deleteApiKey(ctx, me(req), req.params['id'], requestId(req));
      return { status: 204 };
    } },
    { method: 'POST', path: '/v1/auth/api-keys/:id/rotate', async handler(req) {
      const out = await keys.rotateApiKey(ctx, me(req), req.params['id'], requestId(req));
      return { status: 200, body: { ...out.key, token: out.token }, headers: NO_STORE };
    } },
    { method: 'GET', path: '/v1/auth/api-keys/:id/activity', async handler(req) {
      const p = me(req);
      const limitRaw = req.query.get('limit') ?? '50', before = req.query.get('before');
      if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 200) throw invalid('limit must be 1 to 200.');
      if (before !== null && !isUuid(before)) throw invalid('before must be an activity id.');
      return { status: 200, body: await keys.listKeyActivity(ctx, p, req.params['id'], { limit: Number(limitRaw), before: before as Id | null }) };
    } },
  ];
}
