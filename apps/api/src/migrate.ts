// Forward-only SQL migrations owned by the API. Each file in migrations/ is
// applied once, in filename order, in its own transaction. Applied files are
// recorded with a checksum; editing an applied file is an error.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Client } from 'pg';

export interface Migration { version: number; name: string; sql: string; checksum: string }

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 7_165_201; // arbitrary constant: serialises concurrent migrators

export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now())`;

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out: Migration[] = [];
  for (const [i, name] of names.entries()) {
    const m = NAME_RE.exec(name);
    if (!m) throw new Error(`bad migration name: ${name}`);
    if (Number(m![1]) !== i + 1) throw new Error(`migration numbering gap or duplicate at ${name}`);
    const sql = await readFile(path.join(dir, name), 'utf8');
    out.push({ version: Number(m![1]), name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/** Apply pending migrations. `client` is a connected pg Client. Returns applied names. */
export async function migrate(client: Client, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(SCHEMA_MIGRATIONS_DDL);
    const { rows } = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const v of done.keys()) {
      if (!migrations.some((m) => m.version === v)) throw new Error(`database has unknown migration ${v}; refusing to run (downgrade not supported)`);
    }
    const applied: string[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) {
        if (done.get(m.version) !== m.checksum) throw new Error(`checksum mismatch for applied migration ${m.name}`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(m.name);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
