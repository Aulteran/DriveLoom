// Request validation shared by feature modules. Failures are 422 problems with
// the stable code `validation_failed`.
import { HttpProblem } from './problem.ts';
import { Dec, scaleOf } from '../decimal.ts';
import { isUuid } from '../ids.ts';
import type { Id } from '../types.ts';

export const invalid = (detail: string) => new HttpProblem(422, 'validation_failed', 'Validation failed', detail);

/** Body must be a JSON object containing only the allowed keys (schemas use additionalProperties: false). */
export function obj(body: unknown, allowed: readonly string[], what = 'Request body'): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid(`${what} must be a JSON object.`);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw invalid(`Unknown field: ${extra[0]}.`);
  return body as Record<string, unknown>;
}

/** A non-negative exact decimal string with bounded scale and magnitude. */
export function decimal(v: unknown, field: string, o: { maxScale: number; max: string; positive?: boolean }): Dec {
  if (!Dec.isDecimal(v)) throw invalid(`${field} must be a decimal string such as "42.5".`);
  if (scaleOf(v) > o.maxScale) throw invalid(`${field} allows at most ${o.maxScale} decimal places.`);
  const d = Dec.parse(v);
  if (d.isNegative() || (o.positive && d.isZero())) throw invalid(`${field} must be ${o.positive ? 'greater than zero' : 'zero or more'}.`);
  if (d.cmp(Dec.parse(o.max)) > 0) throw invalid(`${field} is too large.`);
  return d;
}

export function instant(v: unknown, field: string): Date {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) throw invalid(`${field} must be an RFC 3339 timestamp with a time zone.`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(`${field} is not a valid timestamp.`);
  return d;
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw invalid(`${field} must be true or false.`);
  return v;
}

export function uuid(v: unknown, field: string): Id {
  if (!isUuid(v)) throw invalid(`${field} must be an id.`);
  return v;
}
