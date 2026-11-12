// Instance backup and restore (milestone 1.6).
//
// An archive is gzip-compressed NDJSON: a header line, then for each table a
// table line followed by one line per row, then a trailer with row counts and
// a SHA-256 over every preceding byte. Values are PostgreSQL text
// representations, so numerics, timestamps, arrays, JSON and image bytes
// survive exactly. The dump reads inside one REPEATABLE READ transaction, so it
// is a consistent snapshot of data and images together.
//
// Restore verifies the whole archive before touching the database, then, in a
// single transaction: (optionally) empties the target, rebuilds the schema at
// the archive's version from this build's migrations, loads every row and
// checks the counts. Any failure rolls back and leaves the target as it was.
// Newer migrations are applied afterwards.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import type pg from 'pg';
import { loadMigrations, migrate, SCHEMA_MIGRATIONS_DDL, type Migration } from './migrate.ts';

export const BACKUP_FORMAT = 'driveloom.backup';
export const BACKUP_VERSION = 1;

/**
 * Short-lived state that must not outlive the instance it was made on: live
 * sessions, rate limits, pending challenges and emailed codes. Everyone signs
 * in again after a restore.
 */
export const EPHEMERAL_TABLES: readonly string[] = ['sessions', 'rate_limits', 'auth_challenges', 'one_time_codes'];

export class BackupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'BackupError'; this.code = code; }
}

interface Header { format: string; version: number; schemaVersion: number; createdAt: string; instanceId: string | null }
interface TableLine { table: string; columns: string[]; types: string[] }
interface Trailer { end: true; tables: Record<string, number>; sha256: string }
export interface BackupInfo { schemaVersion: number; createdAt: string; instanceId: string | null; tables: Record<string, number> }

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function tables(c: pg.ClientBase): Promise<TableLine[]> {
  const { rows } = await c.query<{ table: string; columns: string[]; types: string[] }>(
    `SELECT c.relname AS table, array_agg(a.attname::text ORDER BY a.attnum) AS columns, array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum) AS types
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r' GROUP BY c.relname ORDER BY c.relname`);
  return rows;
}

/** Tables ordered so that every table comes after the tables it references. */
async function loadOrder(c: pg.ClientBase, names: string[]): Promise<string[]> {
  const { rows } = await c.query<{ child: string; parent: string }>(
    `SELECT DISTINCT c.relname AS child, p.relname AS parent FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname = 'public' AND c.oid <> p.oid`);
  const out: string[] = [], left = new Set(names);
  while (left.size) {
    const ready = [...left].filter((t) => !rows.some((r) => r.child === t && left.has(r.parent))).sort();
    if (!ready.length) throw new BackupError('schema_cycle', 'tables reference each other in a cycle');
    for (const t of ready) { out.push(t); left.delete(t); }
  }
  return out;
}

/** Write a consistent archive of the instance to `file` (written to a temporary name first, then renamed). */
export async function createBackup(pool: pg.Pool, file: string, now: () => Date = () => new Date()): Promise<BackupInfo> {
  const tmp = `${file}.partial`;
  const hash = createHash('sha256');
  const gzip = createGzip({ level: 6 });
  const done = pipeline(gzip, createWriteStream(tmp, { mode: 0o600 }));
  const write = async (obj: unknown, hashed = true) => {
    const line = `${JSON.stringify(obj)}\n`;
    if (hashed) hash.update(line);
    if (!gzip.write(line)) await new Promise<void>((r) => gzip.once('drain', r));
  };
  const c = await pool.connect();
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const schemaVersion = (await c.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')).rows[0]!.v;
    if (!schemaVersion) throw new BackupError('not_initialised', 'the database has no schema to back up');
    const instanceId = (await c.query<{ instance_id: string }>('SELECT instance_id::text FROM instance_meta')).rows[0]?.instance_id ?? null;
    const createdAt = now().toISOString();
    await write({ format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion, createdAt, instanceId } satisfies Header);
    const counts: Record<string, number> = {};
    // Parents before children, so a restore can load rows as it reads them.
    const all = new Map((await tables(c)).map((t) => [t.table, t]));
    for (const name of await loadOrder(c, [...all.keys()])) {
      const t = all.get(name)!;
      if (EPHEMERAL_TABLES.includes(t.table)) continue;
      await write(t);
      let n = 0;
      // A cursor keeps memory flat however large the table (images) is.
      await c.query(`DECLARE dl_backup NO SCROLL CURSOR FOR SELECT ${t.columns.map((col) => `${ident(col)}::text`).join(', ')} FROM ${ident(t.table)}`);
      for (;;) {
        const batch = await c.query({ text: 'FETCH 50 FROM dl_backup', rowMode: 'array' });
        if (!batch.rows.length) break;
        for (const row of batch.rows) { await write({ r: row }); n++; }
      }
      await c.query('CLOSE dl_backup');
      counts[t.table] = n;
    }
    await write({ end: true, tables: counts, sha256: hash.digest('hex') } satisfies Trailer, false);
    await c.query('COMMIT');
    gzip.end();
    await done;
    await rename(tmp, file);
    return { schemaVersion, createdAt, instanceId, tables: counts };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    gzip.destroy();
    await done.catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  } finally { c.release(); }
}

type Visitor = { table?(t: TableLine): Promise<void>; row?(t: TableLine, values: (string | null)[]): Promise<void> };

/** Stream an archive, checking structure and integrity. Throws BackupError before returning anything untrustworthy. */
async function read(file: string, known: number, visit: Visitor = {}): Promise<BackupInfo> {
  const hash = createHash('sha256');
  let header: Header | null = null, current: TableLine | null = null, trailer: Trailer | null = null;
  const counts: Record<string, number> = {};
  const input = createReadStream(file);
  const gunzip = createGunzip();
  const failed = new Promise<never>((_, reject) => { input.on('error', reject); gunzip.on('error', reject); });
  failed.catch(() => undefined);
  const lines = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
  const consume = (async () => {
    for await (const line of lines) {
      if (trailer) throw new BackupError('corrupt', 'data after the end marker');
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { throw new BackupError('corrupt', 'a line is not valid JSON'); }
      if (!header) {
        if (obj['format'] !== BACKUP_FORMAT) throw new BackupError('not_a_backup', 'this file is not a DriveLoom backup');
        if (obj['version'] !== BACKUP_VERSION) throw new BackupError('unsupported_version', `backup format version ${String(obj['version'])} is not supported (this build reads ${BACKUP_VERSION})`);
        if (typeof obj['schemaVersion'] !== 'number' || obj['schemaVersion'] < 1) throw new BackupError('corrupt', 'missing schema version');
        if (obj['schemaVersion'] > known) throw new BackupError('newer_schema', `the backup is from a newer DriveLoom (schema ${obj['schemaVersion']}, this build knows ${known}); upgrade first`);
        header = obj as unknown as Header;
      } else if (obj['end'] === true) {
        trailer = obj as unknown as Trailer;
        continue; // the trailer is not part of the hashed content
      } else if (typeof obj['table'] === 'string') {
        const t = obj as unknown as TableLine;
        if (!/^[a-z_][a-z0-9_]*$/.test(t.table) || !Array.isArray(t.columns) || !Array.isArray(t.types) || t.columns.length !== t.types.length || t.table in counts) throw new BackupError('corrupt', 'bad table entry');
        current = t; counts[t.table] = 0;
        await visit.table?.(t);
      } else if (Array.isArray(obj['r'])) {
        if (!current || obj['r'].length !== current.columns.length) throw new BackupError('corrupt', 'row without a matching table');
        counts[current.table]!++;
        await visit.row?.(current, obj['r'] as (string | null)[]);
      } else throw new BackupError('corrupt', 'unrecognised line');
      hash.update(`${line}\n`);
    }
  })();
  try { await Promise.race([consume, failed]); } catch (e) {
    lines.close(); input.destroy();
    if (e instanceof BackupError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') throw new BackupError('unreadable', `cannot read ${file}: ${code}`);
    if (typeof code === 'string' && code.startsWith('Z_')) throw new BackupError('corrupt', 'the archive is damaged or truncated');
    throw e;
  }
  if (!header) throw new BackupError('not_a_backup', 'this file is not a DriveLoom backup');
  const h = header as Header, t = trailer as Trailer | null;
  if (!t) throw new BackupError('corrupt', 'the archive is truncated (no end marker)');
  if (t.sha256 !== hash.digest('hex')) throw new BackupError('corrupt', 'checksum mismatch: the archive was modified or damaged');
  if (JSON.stringify(Object.entries(t.tables).sort()) !== JSON.stringify(Object.entries(counts).sort())) throw new BackupError('corrupt', 'row counts do not match the end marker');
  return { schemaVersion: h.schemaVersion, createdAt: h.createdAt, instanceId: h.instanceId, tables: counts };
}

/** Check an archive without a database. */
export async function verifyBackup(file: string): Promise<BackupInfo> {
  return read(file, (await loadMigrations()).length);
}

export interface RestoreOptions {
  /** Empty a non-empty target first. Without it a non-empty target is refused. */
  replace?: boolean;
}

/**
 * Restore `file` into the database `client` is connected to. The connection
 * must not be inside a transaction. Returns the archive's description.
 */
export async function restoreBackup(client: pg.Client | pg.PoolClient, file: string, opts: RestoreOptions = {}): Promise<BackupInfo> {
  const migrations = await loadMigrations();
  const info = await read(file, migrations.length); // full integrity pass before anything is changed
  const existing = await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'S')");
  if (existing.rows[0].n > 0 && !opts.replace) throw new BackupError('target_not_empty', 'the target database is not empty; restore into an empty database, or pass --replace to overwrite it');
  await client.query('BEGIN');
  try {
    if (opts.replace) {
      // Transactional: if anything below fails, the previous contents come back.
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
    }
    const upTo: Migration[] = migrations.filter((m) => m.version <= info.schemaVersion);
    for (const m of upTo) await client.query(m.sql);
    await client.query(SCHEMA_MIGRATIONS_DDL);
    const have = new Map((await tables(client)).map((t) => [t.table, t]));
    // Rows are loaded as they are read; the archive lists parents before children.
    const inserts = new Map<string, string>();
    await read(file, migrations.length, {
      async table(t) {
        const target = have.get(t.table);
        if (!target || EPHEMERAL_TABLES.includes(t.table)) throw new BackupError('schema_mismatch', `the backup contains table ${t.table}, which schema ${info.schemaVersion} of this build does not have`);
        const unknown = t.columns.filter((col) => !target.columns.includes(col));
        if (unknown.length) throw new BackupError('schema_mismatch', `the backup has column ${t.table}.${unknown[0]}, unknown to this build`);
        // Cast to the target's own column types, never to type names taken from the file.
        const types = t.columns.map((col) => target.types[target.columns.indexOf(col)]!);
        inserts.set(t.table, `INSERT INTO ${ident(t.table)} (${t.columns.map(ident).join(', ')}) VALUES (${types.map((ty, i) => `$${i + 1}::${ty}`).join(', ')})`);
      },
      async row(t, values) { await client.query(inserts.get(t.table)!, values); },
    });
    // The archive must describe the same migrations this build ships.
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    if (applied.rows.length !== upTo.length || applied.rows.some((r, i) => r.version !== upTo[i]!.version || r.checksum !== upTo[i]!.checksum)) {
      throw new BackupError('schema_mismatch', 'the backup was made with different migration files than this build ships');
    }
    for (const [name, n] of Object.entries(info.tables)) {
      const got = (await client.query(`SELECT count(*)::int AS n FROM ${ident(name)}`)).rows[0].n;
      if (got !== n) throw new BackupError('restore_incomplete', `${name}: expected ${n} rows, found ${got}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (e instanceof BackupError) throw e;
    throw new BackupError('restore_failed', `restore failed and was rolled back; the target is unchanged: ${e instanceof Error ? e.message : String(e)}`);
  }
  await migrate(client as pg.Client); // bring an older backup up to this build's schema
  return info;
}
