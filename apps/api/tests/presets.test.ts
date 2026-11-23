import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePreset, validatePresetText, PRESET_KEYS } from '../src/service/preset-schema.ts';

const PATH = 'us/honda/odyssey/2015.json';
const base = () => ({
  schemaVersion: 1, id: 'us-honda-odyssey-2015', version: 1, market: 'us', make: 'honda', model: 'odyssey', year: 2015, reviewedOn: '2026-11-23', sources: [],
  tasks: [{ id: 'oil', name: 'Oil', catalogKey: 'oil_change', description: 'd', rule: { months: 6, distance: { value: '5000', unit: 'mi' } }, trust: 'community', sourceNote: 'n' }],
});
const task0 = (p: ReturnType<typeof base>) => p.tasks[0]! as Record<string, unknown>;
const has = (errs: string[], s: string) => assert.ok(errs.some((e) => e.includes(s)), `expected "${s}" in ${JSON.stringify(errs)}`);

test('a valid preset passes', () => assert.deepEqual(validatePreset(base(), PATH), []));
test('unknown keys are rejected at every level', () => {
  const a = base() as Record<string, unknown>; a.extra = 1; has(validatePreset(a), 'unknown key "extra"');
  const b = base(); task0(b).extra = 1; has(validatePreset(b), 'unknown key "extra"');
  const c = base(); (task0(c).rule as Record<string, unknown>).x = 1; has(validatePreset(c), 'unknown key "x"');
  const d = base(); ((task0(d).rule as { distance: Record<string, unknown> }).distance).x = 1; has(validatePreset(d), 'unknown key "x"');
});
test('a code-like field is rejected', () => {
  const p = base(); task0(p).dashboardCode = 'B1'; has(validatePreset(p), 'unknown key "dashboardCode"');
});
test('duplicate task ids are rejected', () => {
  const p = base(); p.tasks.push({ ...p.tasks[0]! }); has(validatePreset(p), 'duplicated');
});
test('catalogKey must be in CATALOG', () => {
  const p = base(); task0(p).catalogKey = 'nope'; has(validatePreset(p), 'catalogKey');
});
test('decimal distance must be a string', () => {
  const p = base(); (task0(p).rule as { distance: { value: unknown } }).distance.value = 5000; has(validatePreset(p), 'decimal string');
});
test('a rule needs months and/or distance', () => {
  const p = base(); task0(p).rule = {}; has(validatePreset(p), 'months and/or distance');
  const q = base(); delete task0(q).rule; has(validatePreset(q), 'rule is required');
});
test('path must match market/make/model/year', () => {
  has(validatePreset(base(), 'us/honda/odyssey/2016.json'), 'path year');
  has(validatePreset(base(), 'us/toyota/odyssey/2015.json'), 'path make');
  has(validatePreset(base(), 'odyssey.json'), 'must be <market>');
});
test('size cap and invalid JSON', () => {
  has(validatePresetText(' '.repeat(65 * 1024)).errors, 'exceeds');
  has(validatePresetText('{').errors, 'invalid JSON');
});
test('the shipped schema file names the same keys as the validator', async () => {
  const s = JSON.parse(await readFile(new URL('../maintenance-presets/preset.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(s.properties).sort(), [...PRESET_KEYS.top].sort());
  assert.deepEqual(Object.keys(s.properties.tasks.items.properties).sort(), [...PRESET_KEYS.task].sort());
});
test('the shipped 2015 Odyssey preset validates with exactly four tasks', async () => {
  const text = await readFile(new URL(`../maintenance-presets/${PATH}`, import.meta.url), 'utf8');
  const { preset, errors } = validatePresetText(text, PATH);
  assert.deepEqual(errors, []);
  const p = preset as { tasks: { id: string; trust: string }[] };
  assert.deepEqual(p.tasks.map((t) => t.id), ['engine-oil', 'brake-fluid', 'timing-belt', 'transmission-fluid']);
  assert.ok(p.tasks.every((t) => t.trust === 'community'));
});
