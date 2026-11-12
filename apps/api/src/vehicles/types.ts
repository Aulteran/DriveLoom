import type { Id } from '../types.ts';

export type Role = 'owner' | 'editor' | 'viewer';
export type GrantableRole = 'editor' | 'viewer';

export interface Vehicle {
  id: Id;
  name: string;
  make: string | null;
  model: string | null;
  year: number | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** The calling user's role on this vehicle. */
  role: Role;
}
export interface VehicleInput { name: string; make?: string | null; model?: string | null; year?: number | null }
export type VehiclePatch = Partial<VehicleInput>;
export interface Member { userId: Id; role: Role; grantedBy: Id | null; createdAt: string; displayName: string; email: string }
