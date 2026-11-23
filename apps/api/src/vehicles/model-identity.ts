// Normalised make and model names, for matching free-text vehicle details against
// bundled data (maintenance presets). Pure and small on purpose: aliases
// ("VW" for Volkswagen, "CRV" for CR-V) are a later extension of this module.
// A person's own text is never rewritten; this is for comparison only.

/** Lowercase, accents removed, every run of spaces or punctuation turned into one hyphen, trimmed: "  Honda " -> "honda", "CR V" -> "cr-v". */
export function normalizeIdentity(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Whether a free-text name (a vehicle's make or model) names the same thing as a slug or another name. Empty never matches. */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIdentity(a);
  return x !== '' && x === normalizeIdentity(b);
}
