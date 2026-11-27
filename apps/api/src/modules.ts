// Opt-in feature modules. A module is disabled until an administrator turns it
// on for the whole instance (table instance_modules; no row means disabled).
// Each member can additionally hide a module's page for one vehicle; that
// personal choice only affects menus and never permissions or stored data.
import type pg from 'pg';
import type { Route } from './http/app.ts';
import { HttpProblem } from './http/problem.ts';
import { invalid, obj } from './http/validate.ts';
import { requireSessionPrincipal } from './identity.ts';
import { isUuid } from './ids.ts';
import type { Id } from './types.ts';

type Q = Pick<pg.Pool, 'query'>;

export const MODULES = ['service'] as const;
export type ModuleName = (typeof MODULES)[number];
export type ModuleFlags = Record<ModuleName, boolean>;
export const isModuleName = (v: unknown): v is ModuleName => (MODULES as readonly unknown[]).includes(v);

export const moduleDisabled = (name: ModuleName) => new HttpProblem(404, 'module_disabled', 'Module not enabled', `The ${name} module is not enabled on this server.`);

export async function isModuleEnabled(db: Q, name: ModuleName): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>('SELECT enabled FROM instance_modules WHERE module = $1', [name]);
  return rows[0]?.enabled === true;
}

/** Every module and whether it is on; absent rows are off. */
export async function getModules(db: Q): Promise<ModuleFlags> {
  const out = Object.fromEntries(MODULES.map((m) => [m, false])) as ModuleFlags;
  const { rows } = await db.query<{ module: string; enabled: boolean }>('SELECT module, enabled FROM instance_modules');
  for (const r of rows) if (isModuleName(r.module)) out[r.module] = r.enabled;
  return out;
}

export async function setModule(db: Q, name: ModuleName, enabled: boolean): Promise<void> {
  await db.query(
    'INSERT INTO instance_modules (module, enabled) VALUES ($1,$2) ON CONFLICT (module) DO UPDATE SET enabled = $2, updated_at = now()', [name, enabled]);
}

/** Guard for a module's endpoints: throws 404 `module_disabled` unless the instance switch is on. */
export async function requireModule(db: Q, name: ModuleName): Promise<void> {
  if (!(await isModuleEnabled(db, name))) throw moduleDisabled(name);
}

/** Whether a user would see the vehicle's Service page: instance module on and the personal preference not off. */
export async function serviceVisibility(db: Q, vehicleId: Id, userId: Id): Promise<{ showService: boolean; moduleEnabled: boolean; visible: boolean }> {
  const [moduleEnabled, pref] = await Promise.all([
    isModuleEnabled(db, 'service'),
    db.query<{ show_service: boolean }>('SELECT show_service FROM vehicle_user_prefs WHERE vehicle_id = $1 AND user_id = $2', [vehicleId, userId]),
  ]);
  const showService = pref.rows[0]?.show_service ?? true;
  return { showService, moduleEnabled, visible: moduleEnabled && showService };
}

/** Personal per-vehicle preferences. Any member may read and set their own; non-members see 404. */
export function vehiclePrefRoutes(db: pg.Pool): Route[] {
  const member = async (vehicleId: unknown, userId: Id): Promise<Id> => {
    const ok = isUuid(vehicleId) && (await db.query('SELECT 1 FROM vehicle_members WHERE vehicle_id = $1 AND user_id = $2', [vehicleId, userId])).rowCount;
    if (!ok) throw new HttpProblem(404, 'vehicle_not_found', 'Vehicle not found');
    return vehicleId as Id;
  };
  return [
    { method: 'GET', path: '/v1/vehicles/:vehicleId/service-visibility', async handler(r) {
      const p = requireSessionPrincipal(r.ctx);
      return { status: 200, body: await serviceVisibility(db, await member(r.params['vehicleId'], p.userId), p.userId) };
    } },
    { method: 'PUT', path: '/v1/vehicles/:vehicleId/service-visibility', async handler(r) {
      const p = requireSessionPrincipal(r.ctx);
      const vid = await member(r.params['vehicleId'], p.userId);
      const { showService } = obj(r.body, ['showService']);
      if (typeof showService !== 'boolean') throw invalid('showService must be a boolean.');
      await db.query(
        `INSERT INTO vehicle_user_prefs (vehicle_id, user_id, show_service) VALUES ($1,$2,$3)
         ON CONFLICT (vehicle_id, user_id) DO UPDATE SET show_service = $3, updated_at = now()`, [vid, p.userId, showService]);
      return { status: 200, body: await serviceVisibility(db, vid, p.userId) };
    } },
  ];
}
