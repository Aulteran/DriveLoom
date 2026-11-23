// Strict, dependency-free validation of community maintenance preset files
// (apps/api/maintenance-presets/<market>/<make>/<model>/<year>.json). Shared by
// scripts/check-presets.ts and (later) the runtime loader. Any key the schema
// does not name is rejected, so code-like fields cannot be smuggled in.
import { CATALOG } from './maintenance-status.ts';

export const MAX_PRESET_BYTES = 64 * 1024;
export const TRUST = ['manufacturer', 'community'] as const;
export const SEVERITY = ['info', 'caution'] as const;
const TOP = ['schemaVersion', 'id', 'version', 'market', 'make', 'model', 'year', 'yearRange', 'variants', 'reviewedOn', 'sources', 'tasks'];
const SOURCE = ['title', 'url', 'kind', 'note'];
const TASK = ['id', 'name', 'catalogKey', 'description', 'rule', 'trust', 'sourceNote', 'severity'];
const RULE = ['months', 'distance'];
const DISTANCE = ['value', 'unit'];
export const PRESET_KEYS = { top: TOP, source: SOURCE, task: TASK, rule: RULE, distance: DISTANCE };

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function noExtra(o: Record<string, unknown>, allowed: string[], at: string, errs: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${at}: unknown key "${k}"`);
}
function validDate(s: unknown): boolean {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Returns a list of problems; empty means valid. `relPath` (e.g. "us/honda/odyssey/2015.json") enables the path check. */
export function validatePreset(obj: unknown, relPath?: string): string[] {
  const errs: string[] = [];
  if (!isObj(obj)) return ['preset must be a JSON object'];
  noExtra(obj, TOP, 'preset', errs);
  if (obj.schemaVersion !== 1) errs.push('schemaVersion must be 1');
  if (!isStr(obj.id, 80) || !SLUG.test(obj.id)) errs.push('id must be a lowercase slug');
  if (!isInt(obj.version, 1, 1_000_000)) errs.push('version must be an integer >= 1');
  for (const k of ['market', 'make', 'model'] as const) {
    if (!isStr(obj[k], 60) || !SLUG.test(obj[k] as string)) errs.push(`${k} must be a lowercase slug`);
  }
  const hasYear = obj.year !== undefined, hasRange = obj.yearRange !== undefined;
  if (hasYear === hasRange) errs.push('exactly one of year or yearRange is required');
  if (hasYear && !isInt(obj.year, 1900, 2100)) errs.push('year must be an integer 1900-2100');
  if (hasRange) {
    const r = obj.yearRange;
    if (!Array.isArray(r) || r.length !== 2 || !isInt(r[0], 1900, 2100) || !isInt(r[1], 1900, 2100) || (r[0] as number) > (r[1] as number)) errs.push('yearRange must be [from, to] integers, from <= to');
  }
  if (obj.variants !== undefined && (!Array.isArray(obj.variants) || obj.variants.length > 20 || !obj.variants.every((v) => isStr(v, 80)))) errs.push('variants must be a list of up to 20 non-empty strings');
  if (!validDate(obj.reviewedOn)) errs.push('reviewedOn must be a valid YYYY-MM-DD date');

  if (!Array.isArray(obj.sources) || obj.sources.length > 20) errs.push('sources must be a list (may be empty) of at most 20 entries');
  else obj.sources.forEach((s, i) => {
    const at = `sources[${i}]`;
    if (!isObj(s)) { errs.push(`${at} must be an object`); return; }
    noExtra(s, SOURCE, at, errs);
    if (!isStr(s.title, 200)) errs.push(`${at}.title is required (max 200 chars)`);
    if (typeof s.url !== 'string' || !/^https:\/\/[^\s]+$/.test(s.url) || s.url.length > 500) errs.push(`${at}.url must be an https URL`);
    if (!TRUST.includes(s.kind as never)) errs.push(`${at}.kind must be manufacturer or community`);
    if (s.note !== undefined && !isStr(s.note, 300)) errs.push(`${at}.note must be a string up to 300 chars`);
  });

  if (!Array.isArray(obj.tasks) || obj.tasks.length < 1 || obj.tasks.length > 60) errs.push('tasks must be a list of 1-60 entries');
  else {
    const seen = new Set<string>();
    obj.tasks.forEach((t, i) => {
      const at = `tasks[${i}]`;
      if (!isObj(t)) { errs.push(`${at} must be an object`); return; }
      noExtra(t, TASK, at, errs);
      if (!isStr(t.id, 60) || !SLUG.test(t.id)) errs.push(`${at}.id must be a lowercase slug`);
      else if (seen.has(t.id)) errs.push(`${at}.id "${t.id}" is duplicated`);
      else seen.add(t.id);
      if (!isStr(t.name, 100)) errs.push(`${at}.name is required (max 100 chars)`);
      if (t.catalogKey !== undefined && !CATALOG.some((c) => c.key === t.catalogKey)) errs.push(`${at}.catalogKey "${String(t.catalogKey)}" is not a CATALOG key`);
      if (!isStr(t.description, 500)) errs.push(`${at}.description is required (max 500 chars)`);
      if (!TRUST.includes(t.trust as never)) errs.push(`${at}.trust must be manufacturer or community`);
      if (!isStr(t.sourceNote, 300)) errs.push(`${at}.sourceNote is required (max 300 chars)`);
      if (t.severity !== undefined && !SEVERITY.includes(t.severity as never)) errs.push(`${at}.severity must be info or caution`);
      if (!isObj(t.rule)) { errs.push(`${at}.rule is required`); return; }
      const r = t.rule;
      noExtra(r, RULE, `${at}.rule`, errs);
      if (r.months === undefined && r.distance === undefined) errs.push(`${at}.rule needs months and/or distance`);
      if (r.months !== undefined && !isInt(r.months, 1, 1200)) errs.push(`${at}.rule.months must be an integer 1-1200`);
      if (r.distance !== undefined) {
        const d = r.distance;
        if (!isObj(d)) errs.push(`${at}.rule.distance must be an object`);
        else {
          noExtra(d, DISTANCE, `${at}.rule.distance`, errs);
          if (typeof d.value !== 'string' || !DECIMAL.test(d.value) || Number(d.value) <= 0) errs.push(`${at}.rule.distance.value must be a positive decimal string`);
          if (d.unit !== 'km' && d.unit !== 'mi') errs.push(`${at}.rule.distance.unit must be km or mi`);
        }
      }
    });
  }

  if (relPath !== undefined) {
    const m = /^([^/]+)\/([^/]+)\/([^/]+)\/(\d{4})\.json$/.exec(relPath);
    if (!m) errs.push(`path "${relPath}" must be <market>/<make>/<model>/<year>.json`);
    else {
      if (obj.market !== m[1]) errs.push(`path market "${m[1]}" does not match market "${String(obj.market)}"`);
      if (obj.make !== m[2]) errs.push(`path make "${m[2]}" does not match make "${String(obj.make)}"`);
      if (obj.model !== m[3]) errs.push(`path model "${m[3]}" does not match model "${String(obj.model)}"`);
      if (hasYear && obj.year !== Number(m[4])) errs.push(`path year ${m[4]} does not match year ${String(obj.year)}`);
      if (hasRange && Array.isArray(obj.yearRange) && obj.yearRange[0] !== Number(m[4])) errs.push(`path year ${m[4]} must equal the first year of yearRange`);
      const expectedId = hasYear ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : undefined;
      if (expectedId && obj.id !== expectedId) errs.push(`id must be "${expectedId}"`);
    }
  }
  return errs;
}

/** Parses raw file text, enforcing the size cap, then validates. */
export function validatePresetText(text: string, relPath?: string): { preset: unknown; errors: string[] } {
  if (Buffer.byteLength(text) > MAX_PRESET_BYTES) return { preset: null, errors: [`file exceeds ${MAX_PRESET_BYTES} bytes`] };
  let preset: unknown;
  try { preset = JSON.parse(text); } catch (e) { return { preset: null, errors: [`invalid JSON: ${(e as Error).message}`] }; }
  return { preset, errors: validatePreset(preset, relPath) };
}
