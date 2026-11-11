import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { migrate, loadMigrations } from '../src/migrate.ts';

const url = process.env['DATABASE_URL'];
if (!url && process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB set but DATABASE_URL missing');
const skip = url ? false : 'DATABASE_URL not set';

let admin: pg.Client;
const dbs: string[] = [];
async function freshClient() {
  const name = `dl_test_${process.pid}_${dbs.length}`;
  await admin.query(`CREATE DATABASE ${name}`);
  dbs.push(name);
  const u = new URL(url!);
  u.pathname = `/${name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
});
after(async () => {
  if (skip) return;
  for (const n of dbs) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await admin.end();
});

test('migration files are contiguous and named', async () => {
  const ms = await loadMigrations();
  assert.ok(ms.length >= 2);
});

test('migrates from empty database and is idempotent', { skip }, async () => {
  const c = await freshClient();
  const all = (await loadMigrations()).map((m) => m.name);
  assert.deepEqual(await migrate(c), all);
  assert.deepEqual(await migrate(c), []);
  const { rows } = await c.query("SELECT to_regclass('instance_meta') a, to_regclass('audit_events') b");
  assert.ok(rows[0].a && rows[0].b);
  await c.end();
});

test('migrates from a prior snapshot (schema at 0001)', { skip }, async () => {
  const c = await freshClient();
  await c.query(await readFile(new URL('./fixtures/snapshot-0001.sql', import.meta.url), 'utf8'));
  await c.query("INSERT INTO instance_meta (instance_id) VALUES ('018f3b1e-7c4a-7d2e-9a10-5b6c7d8e9f01')");
  const applied = await migrate(c);
  assert.deepEqual(applied, ['0002_audit_events.sql']);
  const { rows } = await c.query('SELECT instance_id FROM instance_meta');
  assert.equal(rows.length, 1, 'existing data preserved');
  await c.end();
});

test('refuses a database with an unknown newer migration', { skip }, async () => {
  const c = await freshClient();
  await migrate(c);
  await c.query("INSERT INTO schema_migrations VALUES (999, 'x', 'x')");
  await assert.rejects(migrate(c), /unknown migration 999/);
  await c.end();
});

test('detects edited applied migration via checksum', { skip }, async () => {
  const c = await freshClient();
  await migrate(c);
  await c.query("UPDATE schema_migrations SET checksum='bad' WHERE version=1");
  await assert.rejects(migrate(c), /checksum mismatch/);
  await c.end();
});

test('failed migration rolls back and is not recorded', { skip }, async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/mig-`);
  await writeFile(`${dir}/0001_ok.sql`, 'CREATE TABLE a (id int);');
  await writeFile(`${dir}/0002_bad.sql`, 'CREATE TABLE b (id int); SELECT 1/0;');
  const c = await freshClient();
  await assert.rejects(migrate(c, `${dir}/`), /0002_bad.sql failed/);
  const { rows } = await c.query("SELECT to_regclass('b') b, (SELECT count(*) FROM schema_migrations)::int n");
  assert.equal(rows[0].b, null);
  assert.equal(rows[0].n, 1);
  await c.end();
});

test('concurrent migrators serialise via advisory lock', { skip }, async () => {
  const c1 = await freshClient();
  const c2 = new pg.Client({ database: c1.database, host: c1.host, port: c1.port, user: c1.user, password: c1.password });
  await c2.connect();
  const [a, b] = await Promise.all([migrate(c1), migrate(c2)]);
  assert.equal(a.length + b.length, (await loadMigrations()).length);
  await c1.end(); await c2.end();
});
