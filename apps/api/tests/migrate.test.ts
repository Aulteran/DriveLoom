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
  assert.deepEqual(applied, (await loadMigrations()).map((m) => m.name).slice(1));
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

test('0018 keeps existing maintenance tasks as they were and enforces the new shapes', { skip }, async () => {
  const { mkdtemp, copyFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const src = new URL('../migrations/', import.meta.url);
  const dir = await mkdtemp(`${tmpdir()}/mig17-`);
  for (const f of (await readdir(src)).filter((n) => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) <= 17)) await copyFile(new URL(f, src), `${dir}/${f}`);
  const c = await freshClient();
  await migrate(c, `${dir}/`);
  await c.query("INSERT INTO vehicles (id, name) VALUES ('018f3b1e-7c4a-7d2e-9a10-5b6c7d8e9f02', 'Car')");
  await c.query("INSERT INTO maintenance_tasks (id, vehicle_id, name, recurring, interval_days) VALUES ('018f3b1e-7c4a-7d2e-9a10-5b6c7d8e9f03', '018f3b1e-7c4a-7d2e-9a10-5b6c7d8e9f02', 'Oil', true, 365)");
  assert.deepEqual((await migrate(c)).map((n) => n.slice(0, 4)), ['0018']);
  assert.deepEqual((await c.query('SELECT interval_days, interval_months, reminders_enabled, preset_id, baseline_kind FROM maintenance_tasks')).rows,
    [{ interval_days: 365, interval_months: null, reminders_enabled: true, preset_id: null, baseline_kind: null }]);
  const ins = (cols: string, vals: string) => c.query(`INSERT INTO maintenance_tasks (id, vehicle_id, name, ${cols}) VALUES (gen_random_uuid(), '018f3b1e-7c4a-7d2e-9a10-5b6c7d8e9f02', 'X', ${vals})`);
  await ins('recurring, interval_months', 'true, 36');
  await assert.rejects(ins('recurring, interval_days, interval_months', 'true, 30, 1'), /single_time_unit/);
  await assert.rejects(ins('recurring, interval_months, first_due_on', "false, 3, '2030-01-01'"), /maintenance_tasks_shape/);
  await assert.rejects(ins('recurring, interval_months, preset_id', "true, 3, 'p'"), /preset_complete/);
  await assert.rejects(ins('recurring, interval_months, baseline_kind', "true, 3, 'reported'"), /baseline_shape/);
  await assert.rejects(ins('recurring, interval_months, baseline_on', "true, 3, '2024-01-01'"), /baseline_shape/);
  await assert.rejects(ins('recurring, interval_months, baseline_kind, baseline_odometer_input', "true, 3, 'tracking', 5"), /baseline_odometer_complete/);
  await assert.rejects(ins('recurring, interval_months, source_trust', "true, 3, 'official'"), /source_trust/);
  await ins('recurring, interval_months, preset_id, preset_version, preset_task_id', "true, 3, 'p', 1, 't'");
  await assert.rejects(ins('recurring, interval_months, preset_id, preset_version, preset_task_id', "true, 6, 'p', 2, 't'"), /maintenance_tasks_preset_idx/);
  await c.end();
});
