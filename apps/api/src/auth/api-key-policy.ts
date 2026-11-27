// Vocabulary for API-key authorization: which permission modules exist, which
// levels each supports, which actions a route can require, and the pure
// functions that compare a key's grants with a requirement.
//
// This file only declares and compares. It does not read requests, the
// database or any key. Every function fails closed: an unknown module, level
// or action is never allowed.

/** What an operation does, by its meaning (not its HTTP verb). */
export const KEY_ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];

/** A grant on one module: none (default) < read < read_write (read+create+update) < full (+delete). */
export const KEY_LEVELS = ['none', 'read', 'read_write', 'full'] as const;
export type KeyLevel = (typeof KEY_LEVELS)[number];

/** Permission modules, in the order the spec lists them. `vehicle_create` is a boolean grant, not a level. */
export const KEY_MODULES = ['vehicle_info', 'vehicle_settings', 'vehicle_create', 'fuel', 'service', 'maintenance', 'notifications', 'statistics'] as const;
export type KeyModule = (typeof KEY_MODULES)[number];

/** Modules granted as a boolean instead of a level. */
export const BOOLEAN_MODULES = ['vehicle_create'] as const satisfies readonly KeyModule[];
export type BooleanModule = (typeof BOOLEAN_MODULES)[number];
/** Modules granted as a level. */
export type LevelModule = Exclude<KeyModule, BooleanModule>;
export const LEVEL_MODULES: readonly LevelModule[] = KEY_MODULES.filter((m): m is LevelModule => !(BOOLEAN_MODULES as readonly string[]).includes(m));

/** The levels a key may hold on each level module (`none` is always allowed). Only these are ever offered or accepted. */
export const SUPPORTED_LEVELS: Readonly<Record<LevelModule, readonly KeyLevel[]>> = {
  vehicle_info: ['none', 'read'],
  vehicle_settings: ['none', 'read_write', 'full'],
  fuel: ['none', 'read', 'read_write', 'full'],
  service: ['none', 'read', 'read_write', 'full'],
  maintenance: ['none', 'read', 'read_write', 'full'],
  notifications: ['none', 'read', 'read_write'],
  statistics: ['none', 'read'],
};

/** The actions a route in each module may require. A route cannot declare anything else. */
export const MODULE_ACTIONS: Readonly<Record<KeyModule, readonly KeyAction[]>> = {
  vehicle_info: ['read'],
  vehicle_settings: ['update', 'delete'],
  vehicle_create: ['create'],
  fuel: ['read', 'create', 'update', 'delete'],
  service: ['read', 'create', 'update', 'delete'],
  maintenance: ['read', 'create', 'update', 'delete'],
  notifications: ['read', 'update'],
  statistics: ['read'],
};

export const isKeyModule = (v: unknown): v is KeyModule => (KEY_MODULES as readonly unknown[]).includes(v);
export const isLevelModule = (v: unknown): v is LevelModule => (LEVEL_MODULES as readonly unknown[]).includes(v);
export const isKeyLevel = (v: unknown): v is KeyLevel => (KEY_LEVELS as readonly unknown[]).includes(v);
export const isKeyAction = (v: unknown): v is KeyAction => (KEY_ACTIONS as readonly unknown[]).includes(v);

/** Whether `level` is a level that `module` offers. Boolean and unknown modules offer none. */
export function isSupportedLevel(module: unknown, level: unknown): boolean {
  return isLevelModule(module) && isKeyLevel(level) && SUPPORTED_LEVELS[module].includes(level);
}

/** Whether a grant at `level` covers `action`. Unknown input is denied. */
export function levelAllows(level: unknown, action: unknown): boolean {
  if (!isKeyLevel(level) || !isKeyAction(action)) return false;
  switch (level) {
    case 'none': return false;
    case 'read': return action === 'read';
    case 'read_write': return action === 'read' || action === 'create' || action === 'update';
    case 'full': return true;
  }
}

/**
 * Extra things a route's effect depends on that the declared module/action
 * cannot express. A route that lists one must be enforced for it at run time
 * (the contract test pins the list):
 * - nested_delete: an update that replaces or removes nested records also needs `delete` on the same module when it really removes one.
 * - task_link: items may link to maintenance tasks; picking a task needs maintenance read, changing task data needs maintenance write.
 * - cascade_unlink: deleting this record clears links held by another module's records.
 * - payload_sections: needs the permission of every section the payload or export actually contains, per record.
 * - preview_equals_commit: a preview or dry run needs the same permissions as the commit it previews.
 * - preset_effects: may also update existing tasks and link service items.
 * - redact_members: the response lists other members; a key must not receive that listing.
 */
export const KEY_DYNAMIC = ['nested_delete', 'task_link', 'cascade_unlink', 'payload_sections', 'preview_equals_commit', 'preset_effects', 'redact_members'] as const;
export type KeyDynamic = (typeof KEY_DYNAMIC)[number];

/**
 * The dynamic effects the server can enforce today. The router refuses a key on any route whose rule lists an effect not in
 * this set (403 api_key_not_allowed), so a route cannot be opened to keys before its run-time rule exists. Where enforced:
 * nested_delete, task_link (ServiceService), cascade_unlink (static `also` on the route), preview_equals_commit and preset_effects
 * (MaintenanceService.applyPreset: one code path for preview and commit), redact_members (NotificationSettingsService).
 */
export const ENFORCED_DYNAMIC: ReadonlySet<KeyDynamic> = new Set<KeyDynamic>(['nested_delete', 'task_link', 'cascade_unlink', 'preview_equals_commit', 'preset_effects', 'redact_members']);

export interface KeyRequirement { readonly module: KeyModule; readonly action: KeyAction }

/** A route a key may call: the permission it always needs, any further fixed ones, and run-time effects to enforce. */
export interface KeyRule extends KeyRequirement {
  readonly also?: readonly KeyRequirement[];
  readonly dynamic?: readonly KeyDynamic[];
}

/**
 * How a route treats API keys. Declared affirmatively for every route.
 * - 'session_only': a key can never call it (also what an undeclared route means).
 * - 'public': needs no credentials and ignores any presented; only for auth 'none' routes outside /v1/auth and /v1/admin.
 * - 'any_key': any valid key, no module grant; only for GET /v1/me.
 * - a rule: the key must hold every listed requirement.
 */
export type KeyPolicy = 'session_only' | 'public' | 'any_key' | KeyRule;

/** What a key holds: a level per module (absent means none) and the vehicle-creation boolean. */
export interface KeyGrants {
  readonly levels: Readonly<Partial<Record<LevelModule, KeyLevel>>>;
  readonly vehicleCreate: boolean;
}

/** Whether `grants` satisfy one requirement. Unknown modules, unsupported levels and unknown actions are denied. */
export function grantsAllow(grants: KeyGrants, req: KeyRequirement): boolean {
  if (!isKeyModule(req.module) || !isKeyAction(req.action)) return false;
  if (!(MODULE_ACTIONS[req.module] as readonly KeyAction[]).includes(req.action)) return false;
  if (req.module === 'vehicle_create') return grants.vehicleCreate === true && req.action === 'create';
  const level = grants.levels[req.module];
  return isSupportedLevel(req.module, level) && levelAllows(level, req.action);
}

/** Whether `grants` satisfy a rule's fixed requirements (its `dynamic` effects are checked where they arise). */
export function rulePermits(grants: KeyGrants, rule: KeyRule): boolean {
  return grantsAllow(grants, rule) && (rule.also ?? []).every((r) => grantsAllow(grants, r));
}
