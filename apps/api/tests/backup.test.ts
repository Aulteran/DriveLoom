import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { BackupError, EPHEMERAL_TABLES, createBackup, restoreBackup, verifyBackup } from '../src/backup.ts';
import { MIGRATIONS_DIR, migrate } from '../src/migrate.ts';
import { uuidv7 } from '../src/ids.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { FuelService } from '../src/fuel/service.ts';
import { harness, signUp, principalFor } from './helpers/auth.ts';
import * as acct from '../src/auth/accounts.ts';

const url = process.env['DATABASE_URL'];
const skip = url ? false : 'DATABASE_URL not set';

/** An empty database (no schema), as a fresh instance would have before first start. */
async function emptyDb(): Promise<{ client: pg.Client; url: string; drop(): Promise<void> }> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `dl_restore_${process.pid}_${uuidv7().replace(/-/g, '').slice(-12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url!); u.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: u.toString() });
  client.on('error', () => undefined);
  await client.connect();
  return { client, url: u.toString(), async drop() { await client.end().catch(() => undefined); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); } };
}

/** Every table's content as text, for comparing two databases. */
async function snapshot(q: Pick<pg.Client, 'query'>): Promise<Record<string, string[]>> {
  const { rows } = await q.query<{ t: string }>("SELECT relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1");
  const out: Record<string, string[]> = {};
  for (const { t } of rows) {
    if (EPHEMERAL_TABLES.includes(t)) continue;
    out[t] = (await q.query(`SELECT x::text AS row FROM "${t}" x`)).rows.map((r) => r.row).sort();
  }
  return out;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))]);

async function seed(h: NonNullable<Awaited<ReturnType<typeof harness>>>) {
  const a = await signUp(h, 'admin@example.test'), b = await signUp(h, 'driver@example.test');
  const pa = await principalFor(h, a.session.token), pb = await principalFor(h, b.session.token);
  const totp = await acct.totpBegin(h.ctx, pb);
  const vehicles = new VehicleService(h.ctx.db), fuel = new FuelService(h.ctx.db, vehicles, h.ctx.now);
  const v = await vehicles.create(pb, { name: 'Restore me', odometerUnit: 'mi', currency: 'EUR' });
  await vehicles.addMember(pb, v.id, pa.userId, 'viewer');
  await fuel.create(pb, v.id, { occurredAt: '2026-05-01T08:00:00Z', odometer: { value: '1000.5', unit: 'mi' }, volume: { value: '10.250', unit: 'gal_us' }, cost: { amount: '55.10', currency: 'CHF', exchangeRate: '1.0637' }, notes: 'näïve "quotes"\n☃' });
  await fuel.create(pb, v.id, { occurredAt: '2026-05-09T08:00:00Z', odometer: { value: '1300', unit: 'mi' }, volume: { value: '9', unit: 'gal_us' } });
  await h.ctx.db.query('INSERT INTO vehicle_images (vehicle_id, content_type, data, uploaded_by) VALUES ($1,$2,$3,$4)', [v.id, 'image/png', PNG, pb.userId]);
  return { a, b, pb, v, totp };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dl-backup-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const code = async (p: Promise<unknown>) => p.then(() => 'no_error', (e) => (e instanceof BackupError ? e.code : `unexpected: ${e}`));

test('full restore into an isolated instance preserves users, vehicles, records and image bytes', { skip }, () => withDir(async (dir) => {
  const h = (await harness())!, target = await emptyDb();
  try {
    const { b, v } = await seed(h);
    const file = path.join(dir, 'instance.dlbackup');
    const info = await createBackup(h.ctx.db, file);
    assert.equal(info.tables['users'], 2);
    assert.equal(info.tables['vehicle_images'], 1);
    for (const t of EPHEMERAL_TABLES) assert.ok(!(t in info.tables), `${t} is not archived`);
    assert.deepEqual(await verifyBackup(file), info);

    assert.deepEqual(await restoreBackup(target.client, file), info);
    assert.deepEqual(await snapshot(target.client), await snapshot(h.ctx.db));
    const img = await target.client.query('SELECT data FROM vehicle_images WHERE vehicle_id = $1', [v.id]);
    assert.ok((img.rows[0].data as Buffer).equals(PNG), 'image bytes are identical');
    // Sessions do not survive: the old cookie is dead on the restored instance, but the password works.
    assert.equal((await target.client.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
    const pool = new pg.Pool({ connectionString: target.url, max: 2 });
    try {
      const ctx = { ...h.ctx, db: pool };
      const again = await acct.login(ctx, { email: 'driver@example.test', password: 'correct horse battery staple' }, { ip: '198.51.100.9', userAgent: 't' });
      assert.equal(again.userId, (await principalFor(h, b.session.token)).userId);
    } finally { await pool.end(); }
    // Restoring again without --replace is refused, with it the result is the same.
    assert.equal(await code(restoreBackup(target.client, file)), 'target_not_empty');
    await target.client.query("UPDATE users SET display_name = 'changed after restore'");
    await restoreBackup(target.client, file, { replace: true });
    assert.deepEqual(await snapshot(target.client), await snapshot(h.ctx.db));
  } finally { await target.drop(); await h.drop(); }
}));

test('damaged, truncated, foreign and unsupported archives are rejected before the database is touched', { skip }, () => withDir(async (dir) => {
  const h = (await harness())!, target = await emptyDb();
  try {
    await seed(h);
    const file = path.join(dir, 'ok.dlbackup');
    await createBackup(h.ctx.db, file);
    const raw = await readFile(file);
    const lines = gunzipSync(raw).toString('utf8').split('\n').filter(Boolean);
    const put = async (name: string, data: Buffer | string[]) => { const f = path.join(dir, name); await writeFile(f, Array.isArray(data) ? gzipSync(data.join('\n') + '\n') : data); return f; };
    const reseal = (ls: string[]) => { const body = ls.slice(0, -1); const t = JSON.parse(ls.at(-1)!); t.sha256 = createHash('sha256').update(body.map((l) => l + '\n').join('')).digest('hex'); return [...body, JSON.stringify(t)]; };
    const header = JSON.parse(lines[0]!);

    const flipped = Buffer.from(raw); flipped[Math.floor(raw.length / 2)]! ^= 0xff;
    const edited = lines.map((l) => l.replace('driver@example.test', 'attacker@example.test'));
    const cases: [string, string][] = [
      [await put('flipped', flipped), 'corrupt'],
      [await put('truncated', raw.subarray(0, raw.length - 40)), 'corrupt'],
      [await put('no-trailer', lines.slice(0, -1)), 'corrupt'],
      [await put('edited', edited), 'corrupt'],
      [await put('dropped-row', [...lines.slice(0, 3), ...lines.slice(4)]), 'corrupt'],
      [await put('text', Buffer.from('not a gzip file')), 'corrupt'],
      [await put('other-json', ['{"hello":"world"}']), 'not_a_backup'],
      [await put('future-format', reseal([JSON.stringify({ ...header, version: 99 }), ...lines.slice(1)])), 'unsupported_version'],
      [await put('future-schema', reseal([JSON.stringify({ ...header, schemaVersion: 9999 }), ...lines.slice(1)])), 'newer_schema'],
      [path.join(dir, 'missing'), 'unreadable'],
    ];
    for (const [f, expected] of cases) {
      assert.equal(await code(verifyBackup(f)), expected, `verify ${path.basename(f)}`);
      assert.equal(await code(restoreBackup(target.client, f)), expected, `restore ${path.basename(f)}`);
    }
    const left = await target.client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'");
    assert.equal(left.rows[0].n, 0, 'nothing was created by any rejected restore');
  } finally { await target.drop(); await h.drop(); }
}));

test('a restore that fails midway rolls back, even with --replace on a live database', { skip }, () => withDir(async (dir) => {
  const h = (await harness())!, live = (await harness())!;
  try {
    await seed(h);
    await signUp(live, 'keeper@example.test');
    const before = await snapshot(live.ctx.db);
    const file = path.join(dir, 'ok.dlbackup');
    await createBackup(h.ctx.db, file);
    const lines = gunzipSync(await readFile(file)).toString('utf8').split('\n').filter(Boolean);
    // A well-formed archive (valid checksum) whose content violates a constraint: a membership for a user that does not exist.
    const at = lines.findIndex((l) => l.includes('"table":"vehicle_members"'));
    const row = JSON.parse(lines[at + 1]!);
    row.r[1] = uuidv7();
    const bad = [...lines.slice(0, at + 1), JSON.stringify(row), ...lines.slice(at + 2, -1)];
    const trailer = JSON.parse(lines.at(-1)!);
    trailer.sha256 = createHash('sha256').update(bad.map((l) => l + '\n').join('')).digest('hex');
    const f = path.join(dir, 'inconsistent.dlbackup');
    await writeFile(f, gzipSync([...bad, JSON.stringify(trailer)].join('\n') + '\n'));
    assert.equal((await verifyBackup(f)).tables['users'], 2, 'the archive itself is intact');

    const c = await live.ctx.db.connect();
    try {
      assert.equal(await code(restoreBackup(c, f, { replace: true })), 'restore_failed');
      assert.deepEqual(await snapshot(c), before, 'the live instance is exactly as it was');
      await restoreBackup(c, file, { replace: true }); // recovery: the good archive still restores
      assert.deepEqual(await snapshot(c), await snapshot(h.ctx.db));
    } finally { c.release(); }
  } finally { await live.drop(); await h.drop(); }
}));

test('upgrade: a backup from an older schema restores and is migrated forward', { skip }, () => withDir(async (dir) => {
  const old = await emptyDb(), target = await emptyDb();
  try {
    // Build an instance at schema version 4 (before fuel) from the first four migration files.
    const partial = path.join(dir, 'migrations');
    await cp(MIGRATIONS_DIR, partial, { recursive: true });
    const all = (await readdir(partial)).sort();
    for (const name of all.slice(4)) await rm(path.join(partial, name));
    await migrate(old.client, partial);
    const user = uuidv7(), vehicle = uuidv7();
    await old.client.query("INSERT INTO instance_meta (instance_id) VALUES ($1)", [uuidv7()]);
    await old.client.query("INSERT INTO users (id, email, display_name) VALUES ($1, 'old@example.test', 'Old Timer')", [user]);
    await old.client.query("INSERT INTO vehicles (id, name) VALUES ($1, 'Vintage')", [vehicle]);
    await old.client.query("INSERT INTO vehicle_members (vehicle_id, user_id, role) VALUES ($1, $2, 'owner')", [vehicle, user]);
    const pool = new pg.Pool({ connectionString: old.url, max: 2 });
    const file = path.join(dir, 'old.dlbackup');
    try { assert.equal((await createBackup(pool, file)).schemaVersion, 4); } finally { await pool.end(); }

    await restoreBackup(target.client, file);
    const v = await target.client.query('SELECT max(version)::int AS v FROM schema_migrations');
    assert.equal(v.rows[0].v, all.length, 'migrated to the current schema');
    const car = await target.client.query('SELECT name, odometer_unit, currency FROM vehicles WHERE id = $1', [vehicle]);
    assert.deepEqual(car.rows[0], { name: 'Vintage', odometer_unit: 'km', currency: 'USD' }, 'old rows gained the new columns');
    assert.equal((await target.client.query('SELECT count(*)::int AS n FROM fill_ups')).rows[0].n, 0);
  } finally { await target.drop(); await old.drop(); }
}));
