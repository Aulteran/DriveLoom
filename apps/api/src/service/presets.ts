// Community maintenance presets: advisory templates bundled with the server in
// apps/api/maintenance-presets/<market>/<make>/<model>/<year>.json. Loaded once
// from disk, never fetched. A file that fails validation (preset-schema.ts) or
// that would not make a valid task is skipped with a warning; it never stops the
// server. This file is the pure part: loading, matching a vehicle and turning a
// preset task into an ordinary task body. Storage and permissions live in
// MaintenanceService (maintenance.ts), which applies presets through the same
// validation and insert path as a typed-in task.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import type { DistanceUnit, Id } from '../types.ts';
import { normalizeIdentity, sameMake, sameModel } from '../vehicles/model-identity.ts';
import { catalogName } from './maintenance-status.ts';
import { parseTask } from './maintenance.ts';
import { validatePresetText } from './preset-schema.ts';

export interface PresetDistance { value: string; unit: DistanceUnit }
export interface PresetTask {
  id: string; name: string; catalogKey?: string; description: string;
  rule: { months?: number; distance?: PresetDistance };
  trust: 'manufacturer' | 'community'; sourceNote: string; severity?: 'info' | 'caution';
}
export interface PresetSource { title: string; url: string; kind: 'manufacturer' | 'community'; note?: string }
export interface Preset {
  schemaVersion: 1; id: string; version: number; market: string; make: string; model: string;
  year?: number; yearRange?: [number, number]; variants?: string[]; reviewedOn: string; sources: PresetSource[]; tasks: PresetTask[];
}

/** The bundled presets directory (in the image: /app/apps/api/maintenance-presets). */
export const PRESETS_DIR = new URL('../../maintenance-presets/', import.meta.url);
export const DEFAULT_MARKET = 'us';

/** The task body a preset task becomes, before the owner's edits and baseline. Reminders start off. */
export function presetTaskBody(p: Preset, t: PresetTask): Record<string, unknown> {
  return {
    name: t.name, catalogKey: t.catalogKey ?? null, recurring: true,
    intervalMonths: t.rule.months ?? null, intervalDistance: t.rule.distance ?? null,
    presetId: p.id, presetVersion: p.version, presetTaskId: t.id,
    remindersEnabled: false, sourceTrust: t.trust, sourceNote: t.sourceNote,
  };
}

/**
 * Reads every *.json under `dir` (recursively; not preset.schema.json),
 * validates it against the strict preset schema and its path, and checks each
 * task would be accepted as a maintenance task. Invalid files and repeated ids
 * are skipped with a warning. A missing directory yields no presets.
 */
export function loadPresets(dir: URL = PRESETS_DIR, warn: (m: string) => void = (m) => console.warn(m)): Preset[] {
  const root = fileURLToPath(dir);
  let files: string[];
  try {
    files = (readdirSync(root, { recursive: true }) as string[]).map((f) => f.split(sep).join('/'))
      .filter((f) => f.endsWith('.json') && f.split('/').pop() !== 'preset.schema.json').sort();
  } catch (e) {
    warn(`maintenance presets: cannot read ${root}: ${(e as Error).message}`);
    return [];
  }
  const out: Preset[] = [];
  for (const rel of files) {
    let text: string;
    try { text = readFileSync(new URL(rel, dir), 'utf8'); } catch (e) { warn(`maintenance presets: skipped ${rel}: ${(e as Error).message}`); continue; }
    const { preset, errors } = validatePresetText(text, rel);
    if (errors.length) { warn(`maintenance presets: skipped ${rel}: ${errors.join('; ')}`); continue; }
    const p = preset as Preset;
    if (out.some((x) => x.id === p.id)) { warn(`maintenance presets: skipped ${rel}: id ${p.id} is already used`); continue; }
    const bad = p.tasks.map((t) => { try { parseTask(presetTaskBody(p, t), new Date()); return null; } catch (e) { return `${t.id}: ${(e as { detail?: string }).detail ?? (e as Error).message}`; } })
      .filter((x) => x !== null);
    if (bad.length) { warn(`maintenance presets: skipped ${rel}: ${bad.join('; ')}`); continue; }
    out.push(p);
  }
  return out;
}

let bundled: Preset[] | null = null;
/** The presets shipped with the server, loaded on first use and kept. */
export function bundledPresets(): Preset[] {
  bundled ??= loadPresets();
  return bundled;
}

export interface VehicleIdentity { make: string | null; model: string | null; year: number | null }

/** What a vehicle lacks for matching; presets are only offered with make, model and year all known. */
export function missingIdentity(v: VehicleIdentity): ('make' | 'model' | 'year')[] {
  const m: ('make' | 'model' | 'year')[] = [];
  if (!normalizeIdentity(v.make)) m.push('make');
  if (!normalizeIdentity(v.model)) m.push('model');
  if (v.year === null) m.push('year');
  return m;
}

/** Presets for this vehicle in this market: same normalised make and model, and the year (or within the year range). */
export function matchPresets(presets: readonly Preset[], v: VehicleIdentity, market: string): Preset[] {
  if (missingIdentity(v).length) return [];
  return presets.filter((p) => p.market === market && sameMake(v.make, p.make) && sameModel(p.make, v.model, p.model)
    && (p.year !== undefined ? p.year === v.year : p.yearRange !== undefined && v.year! >= p.yearRange[0] && v.year! <= p.yearRange[1]));
}

export interface ExistingTask { id: Id; name: string; catalog_key: string | null; preset_id: string | null; preset_task_id: string | null; archived: boolean }

/** The task this vehicle already made from this preset task (archived ones too: re-importing never duplicates). */
export const importedTask = <T extends ExistingTask>(rows: readonly T[], presetId: string, taskId: string): T | null =>
  rows.find((r) => r.preset_id === presetId && r.preset_task_id === taskId) ?? null;

/**
 * An unarchived task without preset provenance that looks like the same job:
 * the same catalog key, or the same name ignoring case and spacing. The oldest wins.
 */
export function similarTask<T extends ExistingTask>(rows: readonly T[], t: PresetTask): { task: T; matchedBy: 'catalogKey' | 'name' } | null {
  const free = rows.filter((r) => r.preset_id === null && !r.archived);
  const byKey = t.catalogKey ? free.find((r) => r.catalog_key === t.catalogKey) : undefined;
  if (byKey) return { task: byKey, matchedBy: 'catalogKey' };
  const n = normalizeIdentity(t.name);
  const byName = free.find((r) => normalizeIdentity(r.name) === n);
  return byName ? { task: byName, matchedBy: 'name' } : null;
}

/** Unlinked service items whose name looks like this task (by its name or catalog name), for the owner to choose from. Never linked automatically. */
export function suggestedItems<T extends { name: string }>(items: readonly T[], t: PresetTask, limit = 5): T[] {
  const names = [t.name, t.catalogKey ? catalogName(t.catalogKey) : undefined].filter((x): x is string => !!x).map(normalizeIdentity);
  return items.filter((i) => {
    const n = normalizeIdentity(i.name);
    return n.length >= 3 && names.some((c) => c === n || c.includes(n) || n.includes(c));
  }).slice(0, limit);
}
