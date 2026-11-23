// Normalised make and model names, for matching free-text vehicle details against
// bundled data (maintenance presets). Pure and small on purpose: a few known
// aliases ("VW" for Volkswagen, "CRV" for CR-V) come from identity-table.ts;
// anything else is compared by plain normalisation. Trim and variant words are
// never dropped. A person's own text is never rewritten; this is for comparison only.
import { MAKES, MODELS } from './identity-table.ts';

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

const makeIndex = new Map<string, string>();
for (const m of MAKES) for (const k of [m.id, m.name, ...(m.aliases ?? [])]) makeIndex.set(normalizeIdentity(k), m.id);
// Models are keyed by make id + model spelling, so one make's alias never captures another's model.
const modelIndex = new Map<string, string>();
for (const m of MODELS) for (const k of [m.id, m.name, ...(m.aliases ?? [])]) modelIndex.set(`${m.make}/${normalizeIdentity(k)}`, m.id);

/** The canonical make id for a spelling ("Chevy " -> "chevrolet"); an unknown make is just its normalised text. Empty stays empty. */
export function canonicalMake(s: string | null | undefined): string {
  const n = normalizeIdentity(s);
  return makeIndex.get(n) ?? n;
}

/** The canonical model id ("CRV" -> "cr-v"), looked up under the vehicle's make when it is given; an unknown model is just its normalised text. */
export function canonicalModel(s: string | null | undefined, make?: string | null): string {
  const n = normalizeIdentity(s);
  if (n === '') return '';
  if (make !== undefined && make !== null) return modelIndex.get(`${canonicalMake(make)}/${n}`) ?? n;
  const hits = new Set(MODELS.filter((m) => modelIndex.get(`${m.make}/${n}`) === m.id).map((m) => m.id));
  return hits.size === 1 ? [...hits][0]! : n;
}

/** Whether two makes are the same make, aliases included. Empty never matches. */
export function sameMake(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalMake(a);
  return x !== '' && x === canonicalMake(b);
}

/** Whether two models are the same model of the same make, aliases included. Empty never matches. */
export function sameModel(make: string | null | undefined, a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalModel(a, make ?? '');
  return x !== '' && x === canonicalModel(b, make ?? '');
}

export interface Suggestion { id: string; name: string }
export interface IdentitySuggestions { makes: Suggestion[]; models: Suggestion[] }

const titled = (slug: string) => slug.split('-').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
const byName = (a: Suggestion, b: Suggestion) => a.name.localeCompare(b.name);

/**
 * Optional suggestions for the vehicle form, from the alias table plus the make/model slugs of the loaded
 * presets. `make` filters the makes by prefix (name, id or alias); when it names exactly one known make
 * (spelling or alias), that make's models are listed too, filtered by the optional `model` prefix.
 * Suggestions only: any other text is a valid make or model.
 */
export function suggestIdentities(make: string, model: string, presets: readonly { make: string; model: string }[]): IdentitySuggestions {
  const mq = normalizeIdentity(make), oq = normalizeIdentity(model);
  const makes = new Map<string, Suggestion>(MAKES.map((m) => [m.id, { id: m.id, name: m.name }]));
  const models = new Map<string, Suggestion & { make: string }>(MODELS.map((m) => [`${m.make}/${m.id}`, { id: m.id, name: m.name, make: m.make }]));
  for (const p of presets) {
    const mk = canonicalMake(p.make), md = canonicalModel(p.model, mk);
    if (!makes.has(mk)) makes.set(mk, { id: mk, name: titled(mk) });
    if (!models.has(`${mk}/${md}`)) models.set(`${mk}/${md}`, { id: md, name: titled(md), make: mk });
  }
  const keys = (id: string) => [id, ...(MAKES.find((m) => m.id === id)?.aliases ?? []), makes.get(id)!.name].map(normalizeIdentity);
  const outMakes = [...makes.values()].filter((m) => mq === '' || keys(m.id).some((k) => k.startsWith(mq))).sort(byName);
  const exact = mq === '' ? '' : canonicalMake(make);
  const outModels = exact !== '' && makes.has(exact)
    ? [...models.values()].filter((m) => m.make === exact && (oq === '' || normalizeIdentity(m.name).startsWith(oq) || m.id.startsWith(oq)))
      .map(({ id, name }) => ({ id, name })).sort(byName)
    : [];
  return { makes: outMakes, models: outModels };
}
