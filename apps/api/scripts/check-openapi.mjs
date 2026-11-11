// Validates the OpenAPI skeleton and the repo conventions the contract relies on.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { Validator } from '@seriousme/openapi-schema-validator';

const file = new URL('../openapi/openapi.yaml', import.meta.url);
const doc = parse(await readFile(file, 'utf8'));
const res = await new Validator().validate(doc);
const errors = [];
if (!res.valid) errors.push(`schema: ${JSON.stringify(res.errors)}`);
if (!/^3\.1\./.test(doc.openapi)) errors.push('openapi must be 3.1.x');
if (!/^\d+\.\d+\.\d+$/.test(doc.info?.version ?? '')) errors.push('info.version must be semver');
for (const p of Object.keys(doc.paths ?? {})) {
  if (!p.startsWith('/v1/')) errors.push(`path ${p} must be under /v1/`);
  for (const [method, op] of Object.entries(doc.paths[p])) {
    if (!op.operationId) errors.push(`${method} ${p} needs operationId`);
    if (!op.responses?.default && !Object.keys(op.responses ?? {}).some((c) => /^[45]/.test(c))) {
      errors.push(`${method} ${p} must document an error response`);
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`openapi ${doc.info.version}: ok (${Object.keys(doc.paths).length} paths)`);
