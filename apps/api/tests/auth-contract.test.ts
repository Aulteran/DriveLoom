import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { authRoutes } from '../src/auth/routes.ts';
import type { AuthContext } from '../src/auth/context.ts';

const doc = parse(await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8'));
const routes = authRoutes({} as AuthContext);
const key = (m: string, p: string) => `${m.toUpperCase()} ${p.replace(/:(\w+)/g, '{$1}')}`;

test('every auth route is in the OpenAPI document and vice versa', () => {
  const implemented = new Set(routes.map((r) => key(r.method, r.path)));
  const documented = new Set<string>();
  for (const [p, item] of Object.entries<Record<string, unknown>>(doc.paths)) {
    if (!p.startsWith('/v1/auth/')) continue;
    for (const m of ['get', 'post', 'put', 'delete', 'patch']) if (item[m]) documented.add(key(m, p));
  }
  assert.deepEqual([...implemented].sort(), [...documented].sort());
});

test('route auth mode matches the documented security requirement', () => {
  for (const r of routes) {
    const op = doc.paths[r.path.replace(/:(\w+)/g, '{$1}')][r.method.toLowerCase()];
    const sec = op.security as unknown[] | undefined;
    if (r.auth === 'none') assert.deepEqual(sec, [], `${r.method} ${r.path} must be public`);
    else if (r.auth === 'optional') assert.ok(sec?.some((s) => Object.keys(s as object).length === 0), `${r.method} ${r.path} optional`);
    else assert.ok(sec === undefined || sec.every((s) => Object.keys(s as object).length > 0), `${r.method} ${r.path} must require a session`);
  }
});

test('every unsafe auth operation documents a problem response', () => {
  for (const [p, item] of Object.entries<Record<string, { responses: Record<string, unknown> }>>(doc.paths)) {
    if (!p.startsWith('/v1/auth/')) continue;
    for (const m of ['get', 'post', 'put', 'delete']) if (item[m]) assert.ok(item[m]!.responses['default'], `${m} ${p}`);
  }
});
