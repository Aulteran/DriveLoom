// Test helpers for any lane: fresh database per test, users and request
// contexts without going through sign-in, and an app with a fake authenticator.
import pg from 'pg';
import { migrate } from '../../src/migrate.ts';
import { uuidv7 } from '../../src/ids.ts';
import type { Id } from '../../src/types.ts';
import type { InstanceRole, Principal, RequestContext } from '../../src/identity.ts';
import type { Authenticator, SessionInfo } from '../../src/http/app.ts';
import { trustFromList } from '../../src/http/ip.ts';

export const ORIGIN = 'https://driveloom.test';
export const noProxies = trustFromList([]);

export interface TestDb { pool: pg.Pool; drop(): Promise<void> }

/** Creates a migrated, isolated database. Returns null when DATABASE_URL is unset. */
export async function createTestDb(): Promise<TestDb | null> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    if (process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB set but DATABASE_URL missing');
    return null;
  }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `dl_test_${process.pid}_${uuidv7().replace(/-/g, '').slice(-12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 8 });
  const c = await pool.connect();
  try { await migrate(c); } finally { c.release(); }
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export interface TestUser { id: Id; email: string; role: InstanceRole; principal: Principal; ctx: RequestContext }

/** Inserts an active user directly (no credentials) and returns a ready principal/context. */
export async function createTestUser(db: pg.Pool, opts: { email?: string; role?: InstanceRole } = {}): Promise<TestUser> {
  const id = uuidv7();
  const email = opts.email ?? `user-${id.slice(-8)}@example.test`;
  const role = opts.role ?? 'user';
  await db.query('INSERT INTO users (id, email, instance_role, email_verified_at) VALUES ($1,$2,$3,now())', [id, email, role]);
  const principal: Principal = { userId: id, sessionId: uuidv7(), instanceRole: role, authenticatedAt: new Date() };
  return { id, email, role, principal, ctx: { principal } };
}

/**
 * Fake authenticator for route tests in other lanes: send `cookie: dl_session=<userId>`
 * for a user created with createTestUser and `x-csrf-token: test-csrf`.
 */
export function fakeAuthenticator(users: Iterable<TestUser>): Authenticator {
  const byId = new Map([...users].map((u) => [u.id as string, u]));
  return {
    async resolveSession(token): Promise<SessionInfo | null> {
      const u = byId.get(token);
      if (!u) return null;
      return { principal: u.principal, sessionId: u.principal.sessionId, userId: u.id, csrfToken: 'test-csrf', pending: false };
    },
  };
}
