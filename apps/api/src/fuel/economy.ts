// Full-to-full economy. Pure functions over fills already in authoritative
// order (occurred_at, odometer_km, id). An interval runs from one full fill to
// the next: the starting fill is excluded, intervening partial purchases and
// the closing fill are included. Anything ambiguous is unavailable, never guessed.
import { Dec } from '../decimal.ts';
import type { Id } from '../types.ts';

export interface Fill {
  id: Id;
  occurredAt: Date;
  odometerKm: Dec;
  volumeL: Dec;
  full: boolean;
  /** The user did not log one or more purchases before this one. */
  missedPrevious: boolean;
  /** Cost in the vehicle's reporting currency, when recorded. */
  reportingCost: Dec | null;
}

export type UnavailableReason = 'partial_fill' | 'no_previous_full_fill' | 'missed_fill' | 'no_distance';

export interface Interval {
  /** Closing full fill. */
  endId: Id;
  startId: Id | null;
  endAt: Date;
  available: boolean;
  reason: UnavailableReason | null;
  distanceKm: Dec;
  volumeL: Dec;
  /** Null when any purchase in the interval has no recorded cost. */
  cost: Dec | null;
}

/** One entry per full fill (the fill that closes, or fails to close, an interval). */
export function intervals(fills: readonly Fill[]): Interval[] {
  const out: Interval[] = [];
  let anchor: Fill | null = null;
  let volume = Dec.ZERO, cost: Dec | null = Dec.ZERO, missed = false;
  for (const f of fills) {
    if (f.missedPrevious) missed = true;
    if (anchor) {
      volume = volume.add(f.volumeL);
      cost = cost && f.reportingCost ? cost.add(f.reportingCost) : null;
    }
    if (!f.full) continue;
    if (!anchor) {
      out.push({ endId: f.id, startId: null, endAt: f.occurredAt, available: false, reason: 'no_previous_full_fill', distanceKm: Dec.ZERO, volumeL: Dec.ZERO, cost: null });
    } else {
      const distanceKm = f.odometerKm.sub(anchor.odometerKm);
      const reason: UnavailableReason | null = missed ? 'missed_fill' : distanceKm.cmp(Dec.ZERO) <= 0 ? 'no_distance' : null;
      out.push({ endId: f.id, startId: anchor.id, endAt: f.occurredAt, available: reason === null, reason, distanceKm, volumeL: volume, cost });
    }
    anchor = f; volume = Dec.ZERO; cost = Dec.ZERO; missed = false;
  }
  return out;
}

export interface Aggregate {
  intervalCount: number;
  distanceKm: Dec;
  volumeL: Dec;
  /** Cost and the distance it covers, over intervals whose purchases all have a cost. */
  cost: Dec;
  costDistanceKm: Dec;
}

/** Sum distance and volume first; economy is computed from the sums by the caller. */
export function aggregate(list: readonly Interval[]): Aggregate {
  let distanceKm = Dec.ZERO, volumeL = Dec.ZERO, cost = Dec.ZERO, costDistanceKm = Dec.ZERO, n = 0;
  for (const i of list) {
    if (!i.available) continue;
    n++;
    distanceKm = distanceKm.add(i.distanceKm);
    volumeL = volumeL.add(i.volumeL);
    if (i.cost) { cost = cost.add(i.cost); costDistanceKm = costDistanceKm.add(i.distanceKm); }
  }
  return { intervalCount: n, distanceKm, volumeL, cost, costDistanceKm };
}

export interface Window { from: Date | null; to: Date | null }

/** An interval belongs to the window its closing fill falls in. */
export const inWindow = (at: Date, w: Window): boolean => (!w.from || at >= w.from) && (!w.to || at < w.to);
