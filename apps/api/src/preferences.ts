// Display preferences. They change how values are shown and compared, never
// what is stored. The instance has default units (chosen by the first
// administrator at setup); each user's preference follows that default,
// field by field, until the user chooses a value of their own.
import type pg from 'pg';
import type { Route } from './http/app.ts';
import { invalid, obj } from './http/validate.ts';
import { requireSessionPrincipal } from './identity.ts';
import type { DistanceUnit, Id, VolumeUnit } from './types.ts';
import { isCurrency, isDistanceUnit, isEconomyUnit, isVolumeUnit, type EconomyUnit } from './units.ts';

export interface Preferences { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit; economyUnit: EconomyUnit; currency: string }
export type PreferenceField = keyof Preferences;
export const PREFERENCE_FIELDS: readonly PreferenceField[] = ['distanceUnit', 'volumeUnit', 'economyUnit', 'currency'];
/** Built-in defaults, used until an administrator sets the instance defaults. */
export const DEFAULT_PREFERENCES: Preferences = { distanceUnit: 'km', volumeUnit: 'l', economyUnit: 'l_per_100km', currency: 'USD' };

type Q = Pick<pg.Pool, 'query'>;
type Row = { distance_unit: DistanceUnit | null; volume_unit: VolumeUnit | null; economy_unit: EconomyUnit | null; currency: string | null };
const fromRow = (r: Row): Partial<Preferences> => {
  const out: Partial<Preferences> = {};
  if (r.distance_unit !== null) out.distanceUnit = r.distance_unit;
  if (r.volume_unit !== null) out.volumeUnit = r.volume_unit;
  if (r.economy_unit !== null) out.economyUnit = r.economy_unit;
  if (r.currency !== null) out.currency = r.currency;
  return out;
};

/**
 * Validate a units object. Every listed field is optional; with `allowNull`,
 * null means "follow the instance default". Unknown fields are refused.
 */
export function parseUnits(v: unknown, what: string, allowNull: false): Partial<Preferences>;
export function parseUnits(v: unknown, what: string, allowNull: true): { [K in PreferenceField]?: Preferences[K] | null };
export function parseUnits(v: unknown, what: string, allowNull: boolean): Record<string, unknown> {
  const b = obj(v, PREFERENCE_FIELDS, what);
  const out: Record<string, unknown> = {};
  const check = (k: PreferenceField, ok: (x: unknown) => boolean, msg: string) => {
    if (!(k in b)) return;
    if (b[k] === null && allowNull) { out[k] = null; return; }
    if (!ok(b[k])) throw invalid(msg);
    out[k] = b[k];
  };
  check('distanceUnit', isDistanceUnit, "distanceUnit must be 'km' or 'mi'.");
  check('volumeUnit', isVolumeUnit, "volumeUnit must be 'l', 'gal_us' or 'gal_imp'.");
  check('economyUnit', isEconomyUnit, "economyUnit must be 'l_per_100km', 'km_per_l', 'mpg_us' or 'mpg_imp'.");
  check('currency', isCurrency, 'currency must be an ISO 4217 code such as EUR.');
  return out;
}

// ---------- instance defaults ----------
export async function getInstanceDefaults(db: Q): Promise<Preferences> {
  const { rows } = await db.query<Row>('SELECT distance_unit, volume_unit, economy_unit, currency FROM instance_settings LIMIT 1');
  return { ...DEFAULT_PREFERENCES, ...(rows[0] ? fromRow(rows[0]) : {}) };
}

export async function setInstanceDefaults(db: Q, patch: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await getInstanceDefaults(db)), ...patch };
  await db.query(
    `INSERT INTO instance_settings (id, distance_unit, volume_unit, economy_unit, currency) VALUES (true,$1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET distance_unit = $1, volume_unit = $2, economy_unit = $3, currency = $4, updated_at = now()`,
    [next.distanceUnit, next.volumeUnit, next.economyUnit, next.currency]);
  return next;
}

// ---------- per-user preferences ----------
/** Only the fields the user chose; the rest follow the instance default. */
export async function getOwnPreferences(db: Q, userId: Id): Promise<Partial<Preferences>> {
  const { rows } = await db.query<Row>('SELECT distance_unit, volume_unit, economy_unit, currency FROM user_preferences WHERE user_id = $1', [userId]);
  return rows[0] ? fromRow(rows[0]) : {};
}

/** Effective preferences: the user's own choices over the instance defaults. */
export async function getPreferences(db: Q, userId: Id): Promise<Preferences> {
  const [defaults, own] = await Promise.all([getInstanceDefaults(db), getOwnPreferences(db, userId)]);
  return { ...defaults, ...own };
}

/** Apply a patch of own choices; a null field goes back to following the instance default. */
export async function setOwnPreferences(db: Q, userId: Id, patch: { [K in PreferenceField]?: Preferences[K] | null }): Promise<void> {
  const own: Record<PreferenceField, unknown> = { distanceUnit: null, volumeUnit: null, economyUnit: null, currency: null, ...(await getOwnPreferences(db, userId)), ...patch };
  await db.query(
    `INSERT INTO user_preferences (user_id, distance_unit, volume_unit, economy_unit, currency) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET distance_unit = $2, volume_unit = $3, economy_unit = $4, currency = $5, updated_at = now()`,
    [userId, own.distanceUnit, own.volumeUnit, own.economyUnit, own.currency]);
}

/**
 * Units chosen while creating an account. The bootstrap administrator's choice
 * becomes the instance default (which that account then follows like everyone
 * else); anyone else's becomes their own preference.
 */
export async function applySignupUnits(db: Q, userId: Id, bootstrapAdmin: boolean, units: Partial<Preferences>): Promise<void> {
  if (bootstrapAdmin) await setInstanceDefaults(db, units);
  else if (Object.keys(units).length) await setOwnPreferences(db, userId, units);
}

/** The response body for the preference endpoints. */
export async function describePreferences(db: Q, userId: Id) {
  const [defaults, own] = await Promise.all([getInstanceDefaults(db), getOwnPreferences(db, userId)]);
  return { ...defaults, ...own, instanceDefaults: defaults, inherited: PREFERENCE_FIELDS.filter((k) => !(k in own)) };
}

export function preferenceRoutes(db: pg.Pool): Route[] {
  return [
    { method: 'GET', path: '/v1/preferences', async handler(r) { return { status: 200, body: await describePreferences(db, requireSessionPrincipal(r.ctx).userId) }; } },
    { method: 'PUT', path: '/v1/preferences', async handler(r) {
      const p = requireSessionPrincipal(r.ctx);
      await setOwnPreferences(db, p.userId, parseUnits(r.body, 'Request body', true));
      return { status: 200, body: await describePreferences(db, p.userId) };
    } },
  ];
}
