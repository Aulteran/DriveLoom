// Validates the OpenAPI skeleton and the repo conventions the contract relies on.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { Validator } from '@seriousme/openapi-schema-validator';
import { KEY_ROUTE_POLICIES } from '../src/auth/api-key-route-policies.ts';

const file = new URL('../openapi/openapi.yaml', import.meta.url);
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
type Operation = { operationId?: string; responses?: Record<string, unknown>; security?: Record<string, unknown>[]; 'x-driveloom-key-policy'?: { requires?: string[]; dynamic?: string[] } };
const doc = parse(await readFile(file, 'utf8'));
const res = await new Validator().validate(doc);
const errors: string[] = [];
if (!res.valid) errors.push(`schema: ${JSON.stringify(res.errors)}`);
if (!/^3\.1\./.test(doc.openapi)) errors.push('openapi must be 3.1.x');
if (!/^\d+\.\d+\.\d+$/.test(doc.info?.version ?? '')) errors.push('info.version must be semver');
for (const p of Object.keys(doc.paths ?? {})) {
  if (!p.startsWith('/v1/')) errors.push(`path ${p} must be under /v1/`);
  for (const [method, op] of Object.entries<Operation>(doc.paths[p])) {
    if (!HTTP_METHODS.has(method)) continue; // path-level keys such as `parameters`
    if (!op.operationId) errors.push(`${method} ${p} needs operationId`);
    if (!op.responses?.default && !Object.keys(op.responses ?? {}).some((c) => /^[45]/.test(c))) {
      errors.push(`${method} ${p} must document an error response`);
    }
  }
}

// API key security must say exactly what the route policy table says (src/auth/api-key-route-policies.ts), both ways:
// key-accessible routes declare `session OR apiKey` plus their requirements; everything else never mentions apiKey.
const seen = new Set<string>();
const names = (op: Operation) => (op.security ?? []).map((r) => Object.keys(r).sort().join('+'));
for (const p of Object.keys(doc.paths ?? {})) {
  for (const [method, op] of Object.entries<Operation>(doc.paths[p])) {
    if (!HTTP_METHODS.has(method)) continue;
    const id = `${method.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ':$1')}`;
    seen.add(id);
    const pol = KEY_ROUTE_POLICIES[id];
    if (pol === undefined) { errors.push(`${id}: no entry in the API key route policy table`); continue; }
    const sec = names(op).sort().join(' | ');
    const ext = op['x-driveloom-key-policy'];
    if (typeof pol === 'object' || pol === 'any_key') {
      if (sec !== 'apiKey | session') errors.push(`${id}: key-accessible, so security must be exactly [session, apiKey] (found: ${JSON.stringify(op.security)})`);
      const want = typeof pol === 'object' ? [pol, ...(pol.also ?? [])].map((r) => `${r.module}.${r.action}`) : [];
      if (JSON.stringify(ext?.requires) !== JSON.stringify(want)) errors.push(`${id}: x-driveloom-key-policy.requires must be ${JSON.stringify(want)} (found ${JSON.stringify(ext?.requires)})`);
      const dyn = typeof pol === 'object' ? pol.dynamic ?? [] : [];
      if (JSON.stringify(ext?.dynamic ?? []) !== JSON.stringify(dyn)) errors.push(`${id}: x-driveloom-key-policy.dynamic must be ${JSON.stringify(dyn)} (found ${JSON.stringify(ext?.dynamic)})`);
    } else {
      if (sec.includes('apiKey')) errors.push(`${id}: policy is ${pol}, so security must not mention apiKey`);
      if (ext !== undefined) errors.push(`${id}: policy is ${pol}, so it must not carry x-driveloom-key-policy`);
      if (pol === 'public' && op.security?.length !== 0) errors.push(`${id}: public routes declare security: []`);
    }
  }
}
for (const id of Object.keys(KEY_ROUTE_POLICIES)) if (!seen.has(id)) errors.push(`${id}: in the API key route policy table but not in the OpenAPI document`);
if (!doc.components?.securitySchemes?.apiKey || doc.components.securitySchemes.apiKey.type !== 'http' || doc.components.securitySchemes.apiKey.scheme !== 'bearer' || doc.components.securitySchemes.apiKey.bearerFormat !== 'dlk') errors.push('components.securitySchemes.apiKey must be an http bearer scheme with bearerFormat dlk');
if (JSON.stringify(doc.security) !== JSON.stringify([{ session: [] }])) errors.push('the global default security must stay session only');
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`openapi ${doc.info.version}: ok (${Object.keys(doc.paths).length} paths)`);
