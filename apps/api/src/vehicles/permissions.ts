// What each vehicle role may do. Every write gate goes through these allowlists
// so a new role is denied by default. Roles: owner > editor (shown as
// "Authorized Manager") > driver > viewer. All members may read and export.
import type { Id } from '../types.ts';
import type { GrantableRole, Role } from './types.ts';

/** Roles the owner can grant or change a member to. `owner` moves only by transfer. */
export const GRANTABLE_ROLES: readonly GrantableRole[] = ['editor', 'driver', 'viewer'];
export const isGrantableRole = (r: unknown): r is GrantableRole => (GRANTABLE_ROLES as readonly unknown[]).includes(r);

/** Vehicle details, the photo and importing purchases. */
export const canEditVehicle = (role: Role): boolean => role === 'owner' || role === 'editor';
/** Recording new fill-ups. */
export const canWriteFuel = (role: Role): boolean => role === 'owner' || role === 'editor' || role === 'driver';
/** Changing or deleting an existing fill-up: managers any record, drivers only those they recorded. */
export const canChangeFill = (role: Role, createdBy: Id | null, userId: Id): boolean =>
  canEditVehicle(role) || (role === 'driver' && createdBy !== null && createdBy === userId);
/** Recording service visits (same roles as fuel). */
export const canWriteService = (role: Role): boolean => role === 'owner' || role === 'editor' || role === 'driver';
/** Changing or deleting a service visit: managers any, drivers only the ones they recorded. */
export const canChangeVisit = (role: Role, createdBy: Id | null, userId: Id): boolean =>
  canEditVehicle(role) || (role === 'driver' && createdBy !== null && createdBy === userId);
/** Granting, changing and revoking other members' roles. */
export const canManageMembers = (role: Role): boolean => role === 'owner';
/** Archive and unarchive. */
export const canArchive = (role: Role): boolean => role === 'owner';
/** Opting the vehicle in or out of friend comparisons. */
export const canManageComparison = (role: Role): boolean => role === 'owner';
export const canTransferOwnership = (role: Role): boolean => role === 'owner';
/** Creating, changing, archiving and deleting maintenance tasks, and snoozing one for the whole vehicle. Drivers and viewers read tasks and may snooze only for themselves. */
export const canManageSchedules = (role: Role): boolean => role === 'owner' || role === 'editor';
