import type { DistanceUnit, Id } from '../types.ts';

export type Role = 'owner' | 'editor' | 'viewer';
export type GrantableRole = 'editor' | 'viewer';

export interface Vehicle {
  id: Id;
  name: string;
  make: string | null;
  model: string | null;
  year: number | null;
  archived: boolean;
  /** Unit of the car's physical odometer; readings are shown in it. */
  odometerUnit: DistanceUnit;
  /** Reporting currency (ISO 4217) for this vehicle's costs. */
  currency: string;
  /** Changes whenever the image changes (cache key); null when there is no image. */
  imageVersion: string | null;
  createdAt: string;
  updatedAt: string;
  /** The calling user's role on this vehicle. */
  role: Role;
}
export interface VehicleInput { name: string; make?: string | null; model?: string | null; year?: number | null; odometerUnit?: DistanceUnit; currency?: string }
/** What other modules need to authorize work on a vehicle. */
export interface VehicleAccess { id: Id; role: Role; archived: boolean; odometerUnit: DistanceUnit; currency: string }
export type VehiclePatch = Partial<VehicleInput>;
export interface Member { userId: Id; role: Role; grantedBy: Id | null; createdAt: string; displayName: string; email: string }
