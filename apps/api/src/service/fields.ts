// Field validators shared by service visits and maintenance tasks.
import { invalid } from '../http/validate.ts';

/** A calendar date YYYY-MM-DD that exists. */
export function dateOnly(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(`${field} must be a date such as 2026-03-14.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw invalid(`${field} is not a valid date.`);
  return v;
}

export function text(v: unknown, field: string, max: number, required = false): string | null {
  if (v === undefined || v === null) { if (required) throw invalid(`${field} is required.`); return null; }
  if (typeof v !== 'string') throw invalid(`${field} must be text.`);
  const t = v.trim();
  if (!t) { if (required) throw invalid(`${field} must not be empty.`); return null; }
  if (t.length > max) throw invalid(`${field} must be at most ${max} characters.`);
  return t;
}
