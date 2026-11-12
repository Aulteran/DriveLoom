// Every implemented route outside /v1/auth (which has its own, stricter test)
// must be documented in the OpenAPI file, and the reverse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { Route } from '../src/http/app.ts';
import { vehicleRoutes } from '../src/vehicles/routes.ts';
import { fuelRoutes } from '../src/fuel/routes.ts';
import { imageRoutes } from '../src/vehicles/images.ts';
import { portabilityRoutes } from '../src/portability/routes.ts';
import { adminRoutes } from '../src/admin/routes.ts';
import { friendRoutes } from '../src/friends/routes.ts';
import { preferenceRoutes } from '../src/preferences.ts';
import { API_VERSION } from '../src/version.ts';

const doc = parse(await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8'));
const key = (m: string, p: string) => `${m.toUpperCase()} ${p.replace(/:(\w+)/g, '{$1}')}`;
export const moduleRoutes: Route[] = [...vehicleRoutes({} as never), ...fuelRoutes({} as never), ...preferenceRoutes({} as never), ...friendRoutes({} as never),
  ...imageRoutes({} as never, {} as never), ...portabilityRoutes({} as never), ...adminRoutes({} as never)];
const SYSTEM = new Set(['GET /v1/health', 'GET /v1/version']);

test('module routes and the OpenAPI document agree', () => {
  const implemented = new Set(moduleRoutes.map((r) => key(r.method, r.path)));
  const documented = new Set<string>();
  for (const [p, item] of Object.entries<Record<string, unknown>>(doc.paths)) {
    if (p.startsWith('/v1/auth/')) continue;
    for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m] && !SYSTEM.has(key(m, p))) documented.add(key(m, p));
  }
  assert.deepEqual([...implemented].sort(), [...documented].sort());
});

test('the server reports the documented API version', () => {
  assert.equal(API_VERSION, doc.info.version);
});
