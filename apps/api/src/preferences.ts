// Account-wide display preferences. They change how values are shown and
// compared, never what is stored.
import type pg from 'pg';
import type { Route } from './http/app.ts';
import { invalid, obj } from './http/validate.ts';
import { requirePrincipal } from './identity.ts';
import type { DistanceUnit, Id, VolumeUnit } from './types.ts';
import { isCurrency, isDistanceUnit, isEconomyUnit, isVolumeUnit, type EconomyUnit } from './units.ts';

export interface Preferences { distanceUnit: DistanceUnit; volumeUnit: VolumeUnit; economyUnit: EconomyUnit; currency: string }
export const DEFAULT_PREFERENCES: Preferences = { distanceUnit: 'km', volumeUnit: 'l', economyUnit: 'l_per_100km', currency: 'USD' };

type Q = Pick<pg.Pool, 'query'>;

export async function getPreferences(db: Q, userId: Id): Promise<Preferences> {
  const { rows } = await db.query<{ distance_unit: DistanceUnit; volume_unit: VolumeUnit; economy_unit: EconomyUnit; currency: string }>(
    'SELECT distance_unit, volume_unit, economy_unit, currency FROM user_preferences WHERE user_id = $1', [userId]);
  const r = rows[0];
  return r ? { distanceUnit: r.distance_unit, volumeUnit: r.volume_unit, economyUnit: r.economy_unit, currency: r.currency } : { ...DEFAULT_PREFERENCES };
}

export async function setPreferences(db: Q, userId: Id, patch: Record<string, unknown>): Promise<Preferences> {
  const next = { ...(await getPreferences(db, userId)) };
  if ('distanceUnit' in patch) { if (!isDistanceUnit(patch['distanceUnit'])) throw invalid("distanceUnit must be 'km' or 'mi'."); next.distanceUnit = patch['distanceUnit']; }
  if ('volumeUnit' in patch) { if (!isVolumeUnit(patch['volumeUnit'])) throw invalid("volumeUnit must be 'l', 'gal_us' or 'gal_imp'."); next.volumeUnit = patch['volumeUnit']; }
  if ('economyUnit' in patch) { if (!isEconomyUnit(patch['economyUnit'])) throw invalid("economyUnit must be 'l_per_100km', 'km_per_l', 'mpg_us' or 'mpg_imp'."); next.economyUnit = patch['economyUnit']; }
  if ('currency' in patch) { if (!isCurrency(patch['currency'])) throw invalid('currency must be an ISO 4217 code such as EUR.'); next.currency = patch['currency']; }
  await db.query(
    `INSERT INTO user_preferences (user_id, distance_unit, volume_unit, economy_unit, currency) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET distance_unit = $2, volume_unit = $3, economy_unit = $4, currency = $5, updated_at = now()`,
    [userId, next.distanceUnit, next.volumeUnit, next.economyUnit, next.currency]);
  return next;
}

export function preferenceRoutes(db: pg.Pool): Route[] {
  return [
    { method: 'GET', path: '/v1/preferences', async handler(r) { return { status: 200, body: await getPreferences(db, requirePrincipal(r.ctx).userId) }; } },
    { method: 'PUT', path: '/v1/preferences', async handler(r) {
      const p = requirePrincipal(r.ctx);
      return { status: 200, body: await setPreferences(db, p.userId, obj(r.body, ['distanceUnit', 'volumeUnit', 'economyUnit', 'currency'])) };
    } },
  ];
}
