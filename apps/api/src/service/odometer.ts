// The one place that answers "what is the latest odometer reading we know for
// this vehicle?". Sources that count: fuel records (fill_ups.odometer_km, dated
// by their UTC day) and service visits that recorded an odometer
// (service_visits.odometer_km, dated by serviced_on). Maintenance task due
// points and snooze targets are never readings.
// The reading chosen is the most recent by date, not the largest number, so one
// mistyped historical figure cannot pin the vehicle at a huge value forever;
// on the same date the higher reading wins.
import type pg from 'pg';
import { Dec } from '../decimal.ts';
import type { Id } from '../types.ts';
import type { Reading } from './maintenance-status.ts';

export interface KnownOdometer extends Reading { source: 'fuel' | 'service' }

export async function latestKnownOdometer(q: Pick<pg.Pool, 'query'>, vehicleId: Id): Promise<KnownOdometer | null> {
  const { rows } = await q.query<{ km: string; on: string; source: 'fuel' | 'service' }>(
    `SELECT km::text, "on"::text, source FROM (
       SELECT odometer_km AS km, (occurred_at AT TIME ZONE 'UTC')::date AS "on", 'fuel' AS source FROM fill_ups WHERE vehicle_id = $1
       UNION ALL
       SELECT odometer_km, serviced_on, 'service' FROM service_visits WHERE vehicle_id = $1 AND odometer_km IS NOT NULL
     ) r ORDER BY "on" DESC, km DESC LIMIT 1`, [vehicleId]);
  const r = rows[0];
  return r ? { km: Dec.parse(r.km), on: r.on, source: r.source } : null;
}
