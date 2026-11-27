// API keys: storage, lifecycle and lookup. Personal, revocable bearer
// credentials; the HTTP surface is in api-key-routes.ts, the vocabulary
// (modules, levels, vehicle policies) in api-key-policy.ts.
//
// Exported API
//   Token        generateApiToken(), isApiKeyToken(s), API_KEY_PREFIX
//   Limits       MAX_ACTIVE_KEYS (25), EXPIRY_OPTIONS, DEFAULT_EXPIRY ('30d')
//   Instance     getApiKeysEnabled(db), setApiKeysEnabled(db, enabled)
//   Lifecycle    createApiKey, listApiKeys, updateApiKey, rotateApiKey, deleteApiKey (revoke, or remove an
//                inactive one), revokeAllApiKeys (explicit lockdown), listKeyActivity
//   Input        parseCreateInput(body), parsePatchInput(body): strict validation, 422 on anything unknown
//   Account      revokeApiKeysForUser(q, userId, reason, ...) and deleteApiKeysForUser(q, userId): call them
//                INSIDE the transaction that changes the account (recovery, disable, deletion)
//   Bearer auth  lookupApiKey(ctx, token) -> { ok: true, key: ResolvedApiKey } | { ok: false, reason }
//                touchApiKeyUsed(ctx, keyId): last_used_at, written at most once a minute
//                recordKeyActivity(q, entry): the one writer of api_key_activity (Phase 3 mutations use it)
//
// Rules this file enforces
//   * Only sha256(token) and a 12-character display prefix are stored; the token is returned once, by create and rotate.
//   * At most 25 active (unexpired, unrevoked) keys per user, counted under a row lock on the user, so concurrent
//     creates cannot exceed it.
//   * Edits compare old and new state on the server. Anything that broadens (more access, a vehicle outside the old
//     scope, a wider mode, a later or no expiry, vehicle creation) needs fresh authentication; reductions and
//     renames do not. Expired or revoked keys can never be edited, rotated or reactivated.
//   * Instance switch off: no create, no rotation, no broadening edit. List, activity, revoke and reductions still work.
//   * "Active" means not revoked and not past expires_at (expires_at NULL = never).
//
// For the bearer middleware (Phase 3): lookupApiKey does one query by token hash and returns the key, its owner's
// instance role, the grants as a KeyGrants (api-key-policy.ts, already filtered to levels each module supports),
// the vehicle mode and the stored vehicle ids. It rejects unknown, revoked, expired, inactive-user and
// instance-disabled keys, with an internal reason that must not be shown to unauthenticated clients. `vehicleIds` is the
// stored snapshot (selected / all_current) and EMPTY for all_current_future; the middleware must still require
// current vehicle membership on every request (membership is never cached here).
import { withTx, type Db } from '../db.ts';
import { HttpProblem } from '../http/problem.ts';
import { invalid, obj } from '../http/validate.ts';
import type { InstanceRole, SessionPrincipal } from '../identity.ts';
import { isUuid, uuidv7 } from '../ids.ts';
import type { Id } from '../types.ts';
import { audit, type AuthContext } from './context.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import { requireFresh } from './sessions.ts';
import {
  KEY_LEVELS, KEY_ACTIONS, LEVEL_MODULES, SUPPORTED_LEVELS, isLevelModule, isSupportedLevel, levelAllows,
  type KeyGrants, type KeyLevel, type LevelModule,
} from './api-key-policy.ts';

type Q = Pick<Db, 'query'>;

// ---------- vocabulary ----------
export const API_KEY_PREFIX = 'dlk_';
const TOKEN_RE = /^dlk_[A-Za-z0-9_-]{43}$/;
export const MAX_ACTIVE_KEYS = 25;
export const MAX_SELECTED_VEHICLES = 200;
export const VEHICLE_MODES = ['selected', 'all_current', 'all_current_future'] as const;
export type VehicleMode = (typeof VEHICLE_MODES)[number];
export const EXPIRY_OPTIONS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000, '365d': 365 * 86_400_000, never: null } as const satisfies Record<string, number | null>;
export type ExpiryOption = keyof typeof EXPIRY_OPTIONS;
export const DEFAULT_EXPIRY: ExpiryOption = '30d';
export type KeyStatus = 'active' | 'expired' | 'revoked';
export type RevokeReason = 'user' | 'revoke_all' | 'account_recovery' | 'operator_recovery' | 'account_disabled' | 'account_deleted';

export const isApiKeyToken = (s: unknown): s is string => typeof s === 'string' && TOKEN_RE.test(s);

/** `dlk_` + 32 random bytes (43 base64url characters): 47 characters, 256 bits. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256Hex(token), prefix: token.slice(0, 12) };
}

const problems = {
  notFound: () => new HttpProblem(404, 'api_key_not_found', 'API key not found'),
  disabled: () => new HttpProblem(403, 'api_keys_disabled', 'API keys are disabled', 'An administrator has turned API keys off for this instance. You can still list, review and revoke keys.'),
  tooMany: () => new HttpProblem(409, 'too_many_api_keys', 'Too many API keys', `You can have at most ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`),
  notActive: () => new HttpProblem(409, 'api_key_not_active', 'API key is not active', 'Expired and revoked keys cannot be changed or reactivated. Create a new key.'),
};

// ---------- instance switch ----------
/** Whether API keys are enabled on this instance. No row means enabled. */
export async function getApiKeysEnabled(db: Q): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>("SELECT enabled FROM instance_flags WHERE flag = 'api_keys'");
  return rows[0]?.enabled ?? true;
}
export async function setApiKeysEnabled(db: Q, enabled: boolean): Promise<void> {
  await db.query("INSERT INTO instance_flags (flag, enabled) VALUES ('api_keys', $1) ON CONFLICT (flag) DO UPDATE SET enabled = $1, updated_at = now()", [enabled]);
}

// ---------- input ----------
export interface KeyShape {
  levels: Partial<Record<LevelModule, Exclude<KeyLevel, 'none'>>>;
  vehicleCreate: boolean;
  vehicleMode: VehicleMode;
  /** Explicit ids; only meaningful for `selected`. */
  vehicleIds: Id[];
}
export interface CreateInput extends KeyShape { name: string; expiresIn: ExpiryOption }
export interface PatchInput {
  name?: string;
  expiresIn?: ExpiryOption;
  /** A complete replacement of the module levels (modules not listed become none). */
  levels?: KeyShape['levels'];
  vehicleCreate?: boolean;
  vehicleMode?: VehicleMode;
  vehicleIds?: Id[];
}

function parseName(v: unknown): string {
  if (typeof v !== 'string') throw invalid('name must be text of 1 to 60 characters.');
  const t = v.trim();
  if (t.length < 1 || t.length > 60 || /\p{C}/u.test(t)) throw invalid('name must be 1 to 60 characters without control characters.');
  return t;
}
function parseExpiry(v: unknown): ExpiryOption {
  if (typeof v !== 'string' || !Object.hasOwn(EXPIRY_OPTIONS, v)) throw invalid(`expiresIn must be one of ${Object.keys(EXPIRY_OPTIONS).join(', ')}.`);
  return v as ExpiryOption;
}
function parseMode(v: unknown): VehicleMode {
  if (typeof v !== 'string' || !(VEHICLE_MODES as readonly string[]).includes(v)) throw invalid(`vehicleMode must be one of ${VEHICLE_MODES.join(', ')}.`);
  return v as VehicleMode;
}
function parseIds(v: unknown): Id[] {
  if (!Array.isArray(v) || v.length > MAX_SELECTED_VEHICLES) throw invalid(`vehicleIds must be a list of at most ${MAX_SELECTED_VEHICLES} vehicle ids.`);
  if (!v.every(isUuid)) throw invalid('vehicleIds must contain only vehicle ids.');
  return [...new Set(v as Id[])];
}
function parseLevels(v: unknown): KeyShape['levels'] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid('permissions must be an object mapping a module to a level.');
  const out: KeyShape['levels'] = {};
  for (const [module, level] of Object.entries(v)) {
    if (module === 'vehicle_create') throw invalid('vehicle creation is not a level; use vehicleCreate: true.');
    if (!isLevelModule(module)) throw invalid(`Unknown permission module: ${module.slice(0, 40)}.`);
    if (!isSupportedLevel(module, level)) throw invalid(`${module} does not support the level ${typeof level === 'string' ? level.slice(0, 20) : 'given'}; it offers ${SUPPORTED_LEVELS[module].join(', ')}.`);
    if (level !== 'none') out[module] = level as Exclude<KeyLevel, 'none'>;
  }
  return out;
}
function parseVehicleCreate(v: unknown): boolean {
  if (typeof v !== 'boolean') throw invalid('vehicleCreate must be true or false.');
  return v;
}

/** Defaults: no module access, no vehicle creation, `selected` mode with no vehicles, 30 days. */
export function parseCreateInput(body: unknown): CreateInput {
  const b = obj(body, ['name', 'expiresIn', 'permissions', 'vehicleCreate', 'vehicleMode', 'vehicleIds']);
  if (b['name'] === undefined) throw invalid('name is required.');
  const vehicleMode = b['vehicleMode'] === undefined ? 'selected' : parseMode(b['vehicleMode']);
  const vehicleIds = b['vehicleIds'] === undefined ? [] : parseIds(b['vehicleIds']);
  if (vehicleMode !== 'selected' && vehicleIds.length) throw invalid('vehicleIds only applies to vehicleMode "selected".');
  return {
    name: parseName(b['name']),
    expiresIn: b['expiresIn'] === undefined ? DEFAULT_EXPIRY : parseExpiry(b['expiresIn']),
    levels: b['permissions'] === undefined ? {} : parseLevels(b['permissions']),
    vehicleCreate: b['vehicleCreate'] === undefined ? false : parseVehicleCreate(b['vehicleCreate']),
    vehicleMode, vehicleIds,
  };
}
export function parsePatchInput(body: unknown): PatchInput {
  const b = obj(body, ['name', 'expiresIn', 'permissions', 'vehicleCreate', 'vehicleMode', 'vehicleIds']);
  const out: PatchInput = {};
  if (b['name'] !== undefined) out.name = parseName(b['name']);
  if (b['expiresIn'] !== undefined) out.expiresIn = parseExpiry(b['expiresIn']);
  if (b['permissions'] !== undefined) out.levels = parseLevels(b['permissions']);
  if (b['vehicleCreate'] !== undefined) out.vehicleCreate = parseVehicleCreate(b['vehicleCreate']);
  if (b['vehicleMode'] !== undefined) out.vehicleMode = parseMode(b['vehicleMode']);
  if (b['vehicleIds'] !== undefined) out.vehicleIds = parseIds(b['vehicleIds']);
  if (out.vehicleMode !== undefined && out.vehicleMode !== 'selected' && out.vehicleIds?.length) throw invalid('vehicleIds only applies to vehicleMode "selected".');
  return out;
}

// ---------- rows and views ----------
interface KeyRow {
  id: Id; user_id: Id; name: string; token_prefix: string; vehicle_mode: VehicleMode; allow_vehicle_create: boolean; credential_version: number;
  created_at: Date; updated_at: Date; last_used_at: Date | null; expires_at: Date | null; rotated_at: Date | null; revoked_at: Date | null; revoked_reason: RevokeReason | null;
  perms: Record<string, string>; vehicle_ids: Id[];
}
const KEY_SELECT = `SELECT k.id, k.user_id, k.name, k.token_prefix, k.vehicle_mode, k.allow_vehicle_create, k.credential_version, k.created_at, k.updated_at, k.last_used_at, k.expires_at, k.rotated_at, k.revoked_at, k.revoked_reason,
  COALESCE((SELECT jsonb_object_agg(p.module, p.level) FROM api_key_permissions p WHERE p.key_id = k.id), '{}'::jsonb) AS perms,
  COALESCE((SELECT array_agg(v.vehicle_id ORDER BY v.vehicle_id) FROM api_key_vehicles v WHERE v.key_id = k.id), '{}'::uuid[]) AS vehicle_ids
  FROM api_keys k`;

export interface ApiKeyView {
  id: Id; name: string; prefix: string; status: KeyStatus;
  createdAt: string; updatedAt: string; lastUsedAt: string | null; expiresAt: string | null; rotatedAt: string | null; revokedAt: string | null;
  vehicleMode: VehicleMode; vehicleIds: Id[]; permissions: Partial<Record<LevelModule, KeyLevel>>; vehicleCreate: boolean;
}

function statusOf(r: Pick<KeyRow, 'revoked_at' | 'expires_at'>, now: Date): KeyStatus {
  if (r.revoked_at) return 'revoked';
  if (r.expires_at && r.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'active';
}
/** Never includes the secret or its hash. */
function toView(r: KeyRow, now: Date): ApiKeyView {
  const permissions: ApiKeyView['permissions'] = {};
  for (const m of LEVEL_MODULES) { const l = r.perms[m]; if (isSupportedLevel(m, l) && l !== 'none') permissions[m] = l as KeyLevel; }
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: r.id, name: r.name, prefix: r.token_prefix, status: statusOf(r, now),
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), lastUsedAt: iso(r.last_used_at), expiresAt: iso(r.expires_at), rotatedAt: iso(r.rotated_at), revokedAt: iso(r.revoked_at),
    vehicleMode: r.vehicle_mode, vehicleIds: r.vehicle_mode === 'all_current_future' ? [] : r.vehicle_ids, permissions, vehicleCreate: r.allow_vehicle_create,
  };
}

async function loadOwned(q: Q, id: unknown, userId: Id, lock: boolean): Promise<KeyRow> {
  if (!isUuid(id)) throw problems.notFound();
  const { rows } = await q.query<KeyRow>(`${KEY_SELECT} WHERE k.id = $1 AND k.user_id = $2${lock ? ' FOR UPDATE OF k' : ''}`, [id, userId]);
  if (!rows[0]) throw problems.notFound(); // someone else's key looks exactly like a missing one
  return rows[0];
}

/** Vehicles the user is a member of right now. */
async function accessibleVehicles(q: Q, userId: Id): Promise<Id[]> {
  const { rows } = await q.query<{ vehicle_id: Id }>('SELECT vehicle_id FROM vehicle_members WHERE user_id = $1 ORDER BY vehicle_id', [userId]);
  return rows.map((r) => r.vehicle_id);
}
async function requireAccessible(q: Q, userId: Id, ids: Id[]): Promise<void> {
  if (!ids.length) return;
  const have = new Set(await accessibleVehicles(q, userId));
  if (ids.some((i) => !have.has(i))) throw invalid('vehicleIds must be vehicles you can currently access.');
}

async function writeBindings(q: Q, keyId: Id, levels: KeyShape['levels'], vehicleIds: Id[] | null): Promise<void> {
  const entries = Object.entries(levels);
  await q.query('DELETE FROM api_key_permissions WHERE key_id = $1', [keyId]);
  if (entries.length) await q.query('INSERT INTO api_key_permissions (key_id, module, level) SELECT $1, m, l FROM unnest($2::text[], $3::text[]) AS t(m, l)', [keyId, entries.map((e) => e[0]), entries.map((e) => e[1])]);
  if (vehicleIds) {
    await q.query('DELETE FROM api_key_vehicles WHERE key_id = $1', [keyId]);
    if (vehicleIds.length) await q.query('INSERT INTO api_key_vehicles (key_id, vehicle_id) SELECT $1, unnest($2::uuid[])', [keyId, vehicleIds]);
  }
}

// ---------- activity ----------
export interface ActivityEntry {
  keyId: Id; userId: Id; keyName: string; action: string;
  targetType?: string | null; targetIds?: Id[]; vehicleId?: Id | null; requestId?: string | null; metadata?: Record<string, unknown>; at?: Date;
}
/** The one writer of api_key_activity. Metadata must be small and safe: never tokens, payloads or receipt content. */
export async function recordKeyActivity(q: Q, e: ActivityEntry): Promise<void> {
  await q.query(
    `INSERT INTO api_key_activity (id, key_id, user_id, key_name, action, target_type, target_ids, vehicle_id, request_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [uuidv7(), e.keyId, e.userId, e.keyName, e.action, e.targetType ?? null, e.targetIds ?? [], e.vehicleId ?? null, e.requestId ?? null, e.metadata ?? {}, e.at ?? new Date()]);
}
const manage = (r: Pick<KeyRow, 'id' | 'user_id' | 'name'>, action: string, now: Date, requestId: string | null, metadata: Record<string, unknown> = {}): ActivityEntry =>
  ({ keyId: r.id, userId: r.user_id, keyName: r.name, action, targetType: 'api_key', targetIds: [r.id], requestId, metadata, at: now });

export interface ActivityItem {
  id: Id; occurredAt: string; action: string; keyName: string; targetType: string | null; targetIds: Id[]; vehicleId: Id | null; requestId: string | null; metadata: Record<string, unknown>;
  /** True when the event concerned a vehicle the owner can no longer access; its vehicle and target ids are withheld. */
  redacted: boolean;
}

/** Owner-only history of one key (also for a removed key). Newest first, keyset-paginated by `before`. */
export async function listKeyActivity(ctx: AuthContext, p: SessionPrincipal, keyId: unknown, o: { limit: number; before: Id | null }): Promise<{ items: ActivityItem[]; nextBefore: Id | null }> {
  if (!isUuid(keyId)) throw problems.notFound();
  const own = await ctx.db.query(
    'SELECT 1 FROM api_keys WHERE id = $1 AND user_id = $2 UNION ALL SELECT 1 FROM api_key_activity WHERE key_id = $1 AND user_id = $2 LIMIT 1', [keyId, p.userId]);
  if (!own.rowCount) throw problems.notFound();
  const { rows } = await ctx.db.query(
    `SELECT a.id, a.created_at, a.action, a.key_name, a.target_type, a.target_ids, a.vehicle_id, a.request_id, a.metadata,
            (a.vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicle_members m WHERE m.vehicle_id = a.vehicle_id AND m.user_id = $2)) AS redacted
       FROM api_key_activity a WHERE a.key_id = $1 AND a.user_id = $2 AND ($3::uuid IS NULL OR a.id < $3) ORDER BY a.id DESC LIMIT $4`,
    [keyId, p.userId, o.before, o.limit + 1]);
  const page = rows.slice(0, o.limit);
  return {
    items: page.map((r): ActivityItem => ({
      id: r.id, occurredAt: r.created_at.toISOString(), action: r.action, keyName: r.key_name, targetType: r.target_type,
      targetIds: r.redacted ? [] : r.target_ids, vehicleId: r.redacted ? null : r.vehicle_id, requestId: r.request_id, metadata: r.redacted ? {} : r.metadata, redacted: r.redacted,
    })),
    nextBefore: rows.length > o.limit ? page[page.length - 1]!.id : null,
  };
}

// ---------- create / list ----------
export interface Created { key: ApiKeyView; token: string }

export async function listApiKeys(ctx: AuthContext, userId: Id): Promise<{ items: ApiKeyView[]; apiKeysEnabled: boolean; maxActiveKeys: number }> {
  const now = ctx.now();
  const { rows } = await ctx.db.query<KeyRow>(`${KEY_SELECT} WHERE k.user_id = $1 ORDER BY k.created_at DESC, k.id DESC`, [userId]);
  return { items: rows.map((r) => toView(r, now)), apiKeysEnabled: await getApiKeysEnabled(ctx.db), maxActiveKeys: MAX_ACTIVE_KEYS };
}

const activeSql = '(revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2))';

/** Creates a key. Needs fresh authentication and an enabled instance. The token is in the result and nowhere else. */
export async function createApiKey(ctx: AuthContext, p: SessionPrincipal, input: CreateInput, requestId: string | null = null): Promise<Created> {
  if (!(await getApiKeysEnabled(ctx.db))) throw problems.disabled();
  requireFresh(ctx, p);
  const now = ctx.now();
  const { token, hash, prefix } = generateApiToken();
  const id = uuidv7();
  const expiresAt = EXPIRY_OPTIONS[input.expiresIn] === null ? null : new Date(now.getTime() + EXPIRY_OPTIONS[input.expiresIn]!);
  const row = await withTx(ctx.db, async (tx) => {
    // The user row lock serialises every create for this user, so the count below cannot be raced past the limit.
    const u = (await tx.query<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [p.userId])).rows[0];
    if (u?.status !== 'active') throw new HttpProblem(403, 'forbidden', 'Forbidden');
    const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND ${activeSql}`, [p.userId, now])).rows[0]!.n;
    if (n >= MAX_ACTIVE_KEYS) throw problems.tooMany();
    let snapshot: Id[] | null;
    if (input.vehicleMode === 'selected') { await requireAccessible(tx, p.userId, input.vehicleIds); snapshot = input.vehicleIds; }
    else if (input.vehicleMode === 'all_current') snapshot = await accessibleVehicles(tx, p.userId);
    else snapshot = [];
    await tx.query(
      `INSERT INTO api_keys (id, user_id, name, token_hash, token_prefix, vehicle_mode, allow_vehicle_create, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)`,
      [id, p.userId, input.name, hash, prefix, input.vehicleMode, input.vehicleCreate, now, expiresAt]);
    await writeBindings(tx, id, input.levels, snapshot);
    const created = await loadOwned(tx, id, p.userId, false);
    await recordKeyActivity(tx, manage(created, 'created', now, requestId, { expires: input.expiresIn, vehicleMode: input.vehicleMode }));
    return created;
  });
  return { key: toView(row, now), token };
}

// ---------- edit ----------
const ACTIONS_OF = (level: KeyLevel | undefined) => KEY_ACTIONS.filter((a) => levelAllows(level, a));
/** Whether `next` allows any action on `module` that `prev` did not. */
const levelBroadens = (prev: KeyLevel | undefined, next: KeyLevel | undefined) => ACTIONS_OF(next).some((a) => !ACTIONS_OF(prev).includes(a));

interface Diff { changed: string[]; broadens: boolean }

/** Updates name, expiry, grants and vehicle scope of an active key. Broadening needs fresh authentication; see the file header. */
export async function updateApiKey(ctx: AuthContext, p: SessionPrincipal, id: unknown, patch: PatchInput, requestId: string | null = null): Promise<ApiKeyView> {
  const now = ctx.now();
  const enabled = await getApiKeysEnabled(ctx.db);
  return withTx(ctx.db, async (tx) => {
    const old = await loadOwned(tx, id, p.userId, true);
    if (statusOf(old, now) !== 'active') throw problems.notActive();
    const diff: Diff = { changed: [], broadens: false };

    const name = patch.name ?? old.name;
    if (name !== old.name) diff.changed.push('name');

    // Grants: `permissions`, when sent, replaces the whole map.
    const oldLevels = Object.fromEntries(LEVEL_MODULES.filter((m) => isSupportedLevel(m, old.perms[m])).map((m) => [m, old.perms[m] as KeyLevel])) as Partial<Record<LevelModule, KeyLevel>>;
    const levels: KeyShape['levels'] = patch.levels ?? (oldLevels as KeyShape['levels']);
    if (patch.levels && LEVEL_MODULES.some((m) => (levels[m] ?? 'none') !== (oldLevels[m] ?? 'none'))) {
      diff.changed.push('permissions');
      if (LEVEL_MODULES.some((m) => levelBroadens(oldLevels[m], levels[m]))) diff.broadens = true;
    }
    const vehicleCreate = patch.vehicleCreate ?? old.allow_vehicle_create;
    if (vehicleCreate !== old.allow_vehicle_create) { diff.changed.push('vehicleCreate'); if (vehicleCreate) diff.broadens = true; }

    // Expiry: a later or no expiry is broader.
    let expiresAt = old.expires_at;
    if (patch.expiresIn !== undefined) {
      const ms = EXPIRY_OPTIONS[patch.expiresIn];
      expiresAt = ms === null ? null : new Date(now.getTime() + ms);
      if ((expiresAt?.getTime() ?? Infinity) !== (old.expires_at?.getTime() ?? Infinity)) {
        diff.changed.push('expiry');
        if ((expiresAt?.getTime() ?? Infinity) > (old.expires_at?.getTime() ?? Infinity)) diff.broadens = true;
      }
    }

    // Vehicle scope. `all_current` is re-snapshotted only when the mode is switched to it.
    const mode = patch.vehicleMode ?? old.vehicle_mode;
    let ids: Id[] | null = null; // null = leave the stored snapshot alone
    const accessible = await accessibleVehicles(tx, p.userId);
    if (patch.vehicleIds !== undefined && mode !== 'selected') throw invalid('vehicleIds only applies to vehicleMode "selected".');
    if (mode === 'selected') {
      if (patch.vehicleIds !== undefined) ids = patch.vehicleIds;
      else if (old.vehicle_mode === 'all_current_future') throw invalid('vehicleIds is required when switching to vehicleMode "selected".');
      if (ids) await requireAccessible(tx, p.userId, ids);
    } else if (mode === 'all_current') {
      if (old.vehicle_mode !== 'all_current') ids = accessible;
    } else {
      ids = [];
    }
    const newIds = ids ?? old.vehicle_ids;
    if (mode !== old.vehicle_mode || (ids && (ids.length !== old.vehicle_ids.length || ids.some((v) => !old.vehicle_ids.includes(v))))) {
      diff.changed.push('vehicles');
      if (mode === 'all_current_future') { if (old.vehicle_mode !== 'all_current_future') diff.broadens = true; }
      else if (old.vehicle_mode !== 'all_current_future' && newIds.some((v) => !old.vehicle_ids.includes(v))) diff.broadens = true;
      // From all_current_future to a fixed set the new set is a subset of what the user can reach: a reduction.
    }

    if (!diff.changed.length) return toView(old, now);
    if (diff.broadens) {
      if (!enabled) throw problems.disabled();
      requireFresh(ctx, p);
    }
    await tx.query('UPDATE api_keys SET name = $2, expires_at = $3, vehicle_mode = $4, allow_vehicle_create = $5, updated_at = $6 WHERE id = $1', [old.id, name, expiresAt, mode, vehicleCreate, now]);
    await writeBindings(tx, old.id, levels, ids);
    const updated = await loadOwned(tx, old.id, p.userId, false);
    await recordKeyActivity(tx, manage(updated, 'updated', now, requestId, { changed: diff.changed, broadened: diff.broadens, ...(name !== old.name ? { previousName: old.name } : {}) }));
    return toView(updated, now);
  });
}

// ---------- rotate / revoke / remove ----------
/** Replaces the secret. Keeps id, grants and expiry. The old token stops working immediately (no grace period). */
export async function rotateApiKey(ctx: AuthContext, p: SessionPrincipal, id: unknown, requestId: string | null = null): Promise<Created> {
  if (!(await getApiKeysEnabled(ctx.db))) throw problems.disabled();
  requireFresh(ctx, p);
  const now = ctx.now();
  const { token, hash, prefix } = generateApiToken();
  const key = await withTx(ctx.db, async (tx) => {
    const old = await loadOwned(tx, id, p.userId, true);
    if (statusOf(old, now) !== 'active') throw problems.notActive();
    await tx.query('UPDATE api_keys SET token_hash = $2, token_prefix = $3, rotated_at = $4, updated_at = $4, last_used_at = NULL, credential_version = credential_version + 1 WHERE id = $1', [old.id, hash, prefix, now]);
    const row = await loadOwned(tx, old.id, p.userId, false);
    await recordKeyActivity(tx, manage(row, 'rotated', now, requestId, { credentialVersion: row.credential_version }));
    return row;
  });
  return { key: toView(key, now), token };
}

/** DELETE: an active key is revoked (immediately, no fresh auth); an expired or revoked key is removed from the list. History is kept either way. */
export async function deleteApiKey(ctx: AuthContext, p: SessionPrincipal, id: unknown, requestId: string | null = null): Promise<'revoked' | 'removed'> {
  const now = ctx.now();
  return withTx(ctx.db, async (tx) => {
    const row = await loadOwned(tx, id, p.userId, true);
    if (statusOf(row, now) === 'active') {
      await tx.query("UPDATE api_keys SET revoked_at = $2, revoked_reason = 'user', updated_at = $2 WHERE id = $1", [row.id, now]);
      await recordKeyActivity(tx, manage(row, 'revoked', now, requestId, { reason: 'user' }));
      return 'revoked';
    }
    await tx.query('DELETE FROM api_keys WHERE id = $1', [row.id]);
    await recordKeyActivity(tx, manage(row, 'removed', now, requestId, { status: statusOf(row, now) }));
    return 'removed';
  });
}

/**
 * Revokes the user's active keys. Callers inside an account change pass their transaction so the revocation commits
 * or rolls back with it. Records one history row per key and one audit event. Returns how many keys were revoked.
 */
export async function revokeApiKeysForUser(q: Q, userId: Id, reason: RevokeReason, now: Date, o: { actor?: Id | null; requestId?: string | null } = {}): Promise<number> {
  const { rows } = await q.query<{ id: Id; name: string }>(
    `UPDATE api_keys SET revoked_at = $2, revoked_reason = $3, updated_at = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) RETURNING id, name`, [userId, now, reason]);
  for (const r of rows) await recordKeyActivity(q, manage({ id: r.id, user_id: userId, name: r.name }, reason === 'revoke_all' ? 'revoked_all' : 'revoked', now, o.requestId ?? null, { reason }));
  if (rows.length) await audit(q, o.actor ?? null, 'api_keys.revoked_all', userId, { reason, count: rows.length }, now);
  return rows.length;
}

/** Explicit lockdown: revoke every active key now. No fresh authentication, by design. */
export async function revokeAllApiKeys(ctx: AuthContext, p: SessionPrincipal, requestId: string | null = null): Promise<number> {
  return withTx(ctx.db, (tx) => revokeApiKeysForUser(tx, p.userId, 'revoke_all', ctx.now(), { actor: p.userId, requestId }));
}

/**
 * Account deletion: remove every key (and, by cascade, its grants, vehicle bindings and idempotency records) and strip the
 * free-text parts of its history, which keeps only stable ids and timestamps like audit_events does. Call inside the deletion transaction.
 */
export async function deleteApiKeysForUser(q: Q, userId: Id, now: Date): Promise<number> {
  // The audit trail names the key in details.apiKey; blank it first (the key ids are still needed to find those rows).
  await q.query(
    `UPDATE audit_events SET details = jsonb_set(details, '{apiKey,name}', '""'::jsonb)
      WHERE details ? 'apiKey' AND jsonb_typeof(details->'apiKey') = 'object' AND details->'apiKey' ? 'name'
        AND details->'apiKey'->>'id' IN (SELECT id::text FROM api_keys WHERE user_id = $1 UNION SELECT key_id::text FROM api_key_activity WHERE user_id = $1)`, [userId]);
  const r = await q.query('DELETE FROM api_keys WHERE user_id = $1', [userId]);
  await q.query("UPDATE api_key_activity SET key_name = '', metadata = '{}', request_id = NULL WHERE user_id = $1", [userId]);
  if (r.rowCount) await audit(q, userId, 'api_keys.deleted_with_account', userId, { count: r.rowCount }, now);
  return r.rowCount ?? 0;
}

// ---------- bearer lookup ----------
/** Stored grants -> KeyGrants. Fail closed: a module or level the policy does not recognise is dropped, never guessed. */
export function grantsFromStored(perms: Record<string, string>, allowVehicleCreate: boolean): KeyGrants {
  const levels: Partial<Record<LevelModule, KeyLevel>> = {};
  for (const m of LEVEL_MODULES) { const l = perms[m]; if (isSupportedLevel(m, l) && (KEY_LEVELS as readonly string[]).includes(l as string)) levels[m] = l as KeyLevel; }
  return { levels, vehicleCreate: allowVehicleCreate === true };
}

export interface ResolvedApiKey {
  id: Id; userId: Id; name: string; instanceRole: InstanceRole;
  vehicleMode: VehicleMode;
  /** The stored snapshot for selected / all_current; empty for all_current_future. Membership must still be checked per request. */
  vehicleIds: ReadonlySet<Id>;
  grants: KeyGrants;
  expiresAt: Date | null; lastUsedAt: Date | null; credentialVersion: number;
}
export type KeyLookup = { ok: true; key: ResolvedApiKey } | { ok: false; reason: 'malformed' | 'unknown' | 'user_inactive' | 'revoked' | 'expired' | 'instance_disabled' };

/** Resolves a presented token by its hash. The reason on failure is for logs and metrics only; clients must get one generic 401. */
export async function lookupApiKey(ctx: AuthContext, token: string): Promise<KeyLookup> {
  if (!isApiKeyToken(token)) return { ok: false, reason: 'malformed' };
  const { rows } = await ctx.db.query<{
    id: Id; user_id: Id; name: string; vehicle_mode: VehicleMode; allow_vehicle_create: boolean; credential_version: number; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null;
    status: string; instance_role: InstanceRole; perms: Record<string, string>; vehicle_ids: Id[]; enabled: boolean;
  }>(
    `SELECT k.id, k.user_id, k.name, k.vehicle_mode, k.allow_vehicle_create, k.credential_version, k.last_used_at, k.expires_at, k.revoked_at, u.status, u.instance_role,
            COALESCE((SELECT jsonb_object_agg(p.module, p.level) FROM api_key_permissions p WHERE p.key_id = k.id), '{}'::jsonb) AS perms,
            COALESCE((SELECT array_agg(v.vehicle_id) FROM api_key_vehicles v WHERE v.key_id = k.id), '{}'::uuid[]) AS vehicle_ids,
            COALESCE((SELECT f.enabled FROM instance_flags f WHERE f.flag = 'api_keys'), true) AS enabled
       FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = $1`, [sha256Hex(token)]);
  const r = rows[0];
  if (!r) return { ok: false, reason: 'unknown' };
  if (r.status !== 'active') return { ok: false, reason: 'user_inactive' };
  if (r.revoked_at) return { ok: false, reason: 'revoked' };
  if (r.expires_at && r.expires_at.getTime() <= ctx.now().getTime()) return { ok: false, reason: 'expired' };
  if (!r.enabled) return { ok: false, reason: 'instance_disabled' };
  // Fail closed: anything the policy does not recognise is dropped, never guessed.
  return {
    ok: true,
    key: {
      id: r.id, userId: r.user_id, name: r.name, instanceRole: r.instance_role, vehicleMode: r.vehicle_mode,
      vehicleIds: new Set(r.vehicle_mode === 'all_current_future' ? [] : r.vehicle_ids),
      grants: grantsFromStored(r.perms, r.allow_vehicle_create),
      expiresAt: r.expires_at, lastUsedAt: r.last_used_at, credentialVersion: r.credential_version,
    },
  };
}

/** Records use, at most once a minute per key (one conditional UPDATE, so concurrent requests do not pile up writes). */
export async function touchApiKeyUsed(ctx: AuthContext, keyId: Id): Promise<boolean> {
  const now = ctx.now();
  const r = await ctx.db.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at <= $3)', [keyId, now, new Date(now.getTime() - 60_000)]);
  return (r.rowCount ?? 0) > 0;
}
