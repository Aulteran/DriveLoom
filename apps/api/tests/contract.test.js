import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

test('OpenAPI skeleton passes check script', () => {
  const out = execFileSync('node', ['scripts/check-openapi.mjs'], { encoding: 'utf8' });
  assert.match(out, /ok/);
});

test('Decimal schema accepts exact strings only', async () => {
  const doc = parse(await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8'));
  const re = new RegExp(doc.components.schemas.Decimal.pattern);
  for (const ok of ['0', '10', '-3.5', '42.375']) assert.ok(re.test(ok), ok);
  for (const bad of ['', '01', '1e3', '.5', '1.', 'NaN']) assert.ok(!re.test(bad), bad);
});

test('unit fixtures are consistent with the contract enums', async () => {
  const doc = parse(await readFile(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8'));
  const fx = JSON.parse(await readFile(new URL('./fixtures/decimal-cases.json', import.meta.url), 'utf8'));
  const vol = doc.components.schemas.VolumeUnit.enum;
  for (const r of fx.roundTrips) assert.ok(vol.includes(r.unit));
});
