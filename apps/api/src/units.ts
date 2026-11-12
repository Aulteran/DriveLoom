// Physical units. Base units are kilometres and litres. Constants are exact by
// definition (international mile, US liquid gallon, imperial gallon).
import { Dec } from './decimal.ts';
import type { Decimal, DistanceUnit, VolumeUnit } from './types.ts';

export type EconomyUnit = 'l_per_100km' | 'km_per_l' | 'mpg_us' | 'mpg_imp';

export const DISTANCE_UNITS: readonly DistanceUnit[] = ['km', 'mi'];
export const VOLUME_UNITS: readonly VolumeUnit[] = ['l', 'gal_us', 'gal_imp'];
export const ECONOMY_UNITS: readonly EconomyUnit[] = ['l_per_100km', 'km_per_l', 'mpg_us', 'mpg_imp'];

export const KM_PER: Record<DistanceUnit, Dec> = { km: Dec.int(1), mi: Dec.parse('1.609344') };
export const L_PER: Record<VolumeUnit, Dec> = { l: Dec.int(1), gal_us: Dec.parse('3.785411784'), gal_imp: Dec.parse('4.54609') };

export const isDistanceUnit = (v: unknown): v is DistanceUnit => DISTANCE_UNITS.includes(v as DistanceUnit);
export const isVolumeUnit = (v: unknown): v is VolumeUnit => VOLUME_UNITS.includes(v as VolumeUnit);
export const isEconomyUnit = (v: unknown): v is EconomyUnit => ECONOMY_UNITS.includes(v as EconomyUnit);

export const toKm = (v: Dec, unit: DistanceUnit): Dec => v.mul(KM_PER[unit]);
export const fromKm = (km: Dec, unit: DistanceUnit): Dec => km.div(KM_PER[unit]);
export const toLitres = (v: Dec, unit: VolumeUnit): Dec => v.mul(L_PER[unit]);
export const fromLitres = (l: Dec, unit: VolumeUnit): Dec => l.div(L_PER[unit]);

/**
 * Economy from aggregated distance and volume. Returns null when it is not
 * defined (no distance or no fuel), never a ratio of rounded values.
 */
export function economy(distanceKm: Dec, volumeL: Dec, unit: EconomyUnit): Dec | null {
  if (distanceKm.cmp(Dec.ZERO) <= 0 || volumeL.cmp(Dec.ZERO) <= 0) return null;
  switch (unit) {
    case 'l_per_100km': return volumeL.mul(Dec.int(100)).div(distanceKm);
    case 'km_per_l': return distanceKm.div(volumeL);
    case 'mpg_us': return fromKm(distanceKm, 'mi').div(fromLitres(volumeL, 'gal_us'));
    case 'mpg_imp': return fromKm(distanceKm, 'mi').div(fromLitres(volumeL, 'gal_imp'));
  }
}

/** Distance unit that goes with an economy unit, for cost-per-distance figures. */
export const distanceUnitOf = (e: EconomyUnit): DistanceUnit => (e === 'mpg_us' || e === 'mpg_imp' ? 'mi' : 'km');

/** Display scales (fractional digits). Rounding happens only here. */
export const DISPLAY_SCALE = { distance: 1, volume: 2, economy: 2 } as const;

const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));
export const isCurrency = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v) && CURRENCIES.has(v);

/** Minor-unit digits for a currency (2 for USD, 0 for JPY, 3 for KWD). */
export function currencyScale(code: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
}
export const money = (v: Dec, currency: string): Decimal => v.toFixed(currencyScale(currency));
