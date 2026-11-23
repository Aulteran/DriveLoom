import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { uuidv7 } from '../src/ids.ts';
import type { Principal } from '../src/identity.ts';
import { VehicleService } from '../src/vehicles/service.ts';
import { ApiError } from '../src/vehicles/errors.ts';

const url = process.env['DATABASE_URL'];
if (!url && process.env['REQUIRE_DB']) throw new Error('REQUIRE_DB set but DATABASE_URL missing');
const skip = url ? false : 'DATABASE_URL not set';

let admin: pg.Client, pool: pg.Pool, svc: VehicleService, dbName: string;

async function user(role: 'admin' | 'user' = 'user', status = 'active'): Promise<Principal> {
  const id = uuidv7();
  await pool.query('INSERT INTO users (id, email, instance_role, status) VALUES ($1,$2,$3,$4)', [id, `${id}@example.test`, role, status]);
  return { userId: id, sessionId: uuidv7(), instanceRole: role, authenticatedAt: new Date() };
}
async function rejects(p: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(p, (e) => e instanceof ApiError && e.status === status && (!code || e.code === code), `expected ${status} ${code ?? ''}`);
}
async function audit(vehicleId: string) {
  const { rows } = await pool.query('SELECT action, actor_id, details FROM audit_events WHERE subject_id = $1 ORDER BY id', [vehicleId]);
  return rows;
}

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  dbName = `dl_test_veh_${process.pid}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(url!);
  u.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: u.toString(), max: 12 });
  pool.on('error', () => {}); // idle clients are killed when the database is dropped
  const c = await pool.connect();
  await migrate(c);
  c.release();
  svc = new VehicleService(pool);
});
after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

test('create makes the caller the owner and audits it', { skip }, async () => {
  const a = await user();
  const v = await svc.create(a, { name: '  Civic ', make: 'Honda', year: 2019 });
  assert.equal(v.name, 'Civic');
  assert.equal(v.role, 'owner');
  assert.deepEqual((await audit(v.id)).map((r) => r.action), ['vehicle.create']);
  await rejects(svc.create(a, { name: '' }), 422, 'validation_failed');
  await rejects(svc.create(a, { name: 'x', year: 1800 }), 422);
});

test('non-members get 404 on every operation, including existence probes', { skip }, async () => {
  const a = await user(), b = await user(), adm = await user('admin');
  const v = await svc.create(a, { name: 'Private' });
  for (const who of [b, adm]) {
    await rejects(svc.get(who, v.id), 404, 'vehicle_not_found');
    await rejects(svc.update(who, v.id, { name: 'x' }), 404);
    await rejects(svc.setArchived(who, v.id, true), 404);
    await rejects(svc.listMembers(who, v.id), 404);
    await rejects(svc.addMember(who, v.id, who.userId, 'viewer'), 404);
    await rejects(svc.removeMember(who, v.id, a.userId), 404);
    await rejects(svc.transferOwnership(who, v.id, who.userId), 404);
    assert.deepEqual(await svc.list(who), []);
  }
  await rejects(svc.get(b, 'not-a-uuid'), 404);
  await rejects(svc.get(b, uuidv7()), 404); // same answer as an existing vehicle
});

test('roles: viewer reads, editor edits, only owner manages', { skip }, async () => {
  const o = await user(), e = await user(), w = await user(), other = await user();
  const v = await svc.create(o, { name: 'Shared' });
  await svc.addMember(o, v.id, e.userId, 'editor');
  await svc.addMember(o, v.id, w.userId, 'viewer');
  assert.equal((await svc.get(w, v.id)).role, 'viewer');
  assert.equal((await svc.listMembers(w, v.id)).length, 3);
  await rejects(svc.update(w, v.id, { name: 'no' }), 403, 'forbidden');
  assert.equal((await svc.update(e, v.id, { name: 'Edited' })).name, 'Edited');
  for (const who of [e, w]) {
    await rejects(svc.addMember(who, v.id, other.userId, 'viewer'), 403);
    await rejects(svc.changeMemberRole(who, v.id, w.userId, 'editor'), 403);
    await rejects(svc.setArchived(who, v.id, true), 403);
    await rejects(svc.transferOwnership(who, v.id, who.userId), 403);
    await rejects(svc.removeMember(who, v.id, o.userId), 403);
  }
  await rejects(svc.addMember(o, v.id, e.userId, 'viewer'), 409, 'already_member');
  await rejects(svc.addMember(o, v.id, other.userId, 'owner'), 422);
  await rejects(svc.addMember(o, v.id, uuidv7(), 'viewer'), 422);
  await rejects(svc.addMember(o, v.id, (await user('user', 'disabled')).userId, 'viewer'), 422);
  assert.equal((await svc.changeMemberRole(o, v.id, w.userId, 'editor')).role, 'editor');
  await rejects(svc.changeMemberRole(o, v.id, o.userId, 'viewer'), 409, 'owner_immutable');
});

test('members can leave; removed members lose access; owner cannot be removed', { skip }, async () => {
  const o = await user(), m = await user(), r = await user();
  const v = await svc.create(o, { name: 'Leave' });
  await svc.addMember(o, v.id, m.userId, 'viewer');
  await svc.addMember(o, v.id, r.userId, 'editor');
  await svc.removeMember(m, v.id, m.userId);
  await svc.removeMember(o, v.id, r.userId);
  await rejects(svc.get(m, v.id), 404);
  await rejects(svc.get(r, v.id), 404);
  await rejects(svc.removeMember(o, v.id, o.userId), 409, 'owner_required');
  const actions = (await audit(v.id)).map((x) => x.action);
  assert.ok(actions.includes('member.leave') && actions.includes('member.remove'));
});

test('archive hides from default list and is owner-only', { skip }, async () => {
  const o = await user();
  const v = await svc.create(o, { name: 'Old' });
  assert.equal((await svc.setArchived(o, v.id, true)).archived, true);
  assert.equal((await svc.list(o)).length, 0);
  assert.equal((await svc.list(o, { includeArchived: true })).length, 1);
  assert.equal((await svc.setArchived(o, v.id, false)).archived, false);
});

test('delete is owner-only, needs an archived vehicle, and audits', { skip }, async () => {
  const o = await user(), e = await user(), w = await user(), stranger = await user();
  const v = await svc.create(o, { name: 'Scrap' });
  await svc.addMember(o, v.id, e.userId, 'editor');
  await svc.addMember(o, v.id, w.userId, 'viewer');
  await svc.setArchived(o, v.id, true);
  await rejects(svc.delete(e, v.id), 403, 'forbidden');
  await rejects(svc.delete(w, v.id), 403, 'forbidden');
  await rejects(svc.delete(stranger, v.id), 404, 'vehicle_not_found');
  await rejects(svc.delete(o, 'not-a-uuid'), 404);
  assert.equal((await svc.get(o, v.id)).archived, true, 'refused deletes leave the vehicle in place');

  await svc.delete(o, v.id);
  await rejects(svc.get(o, v.id), 404, 'vehicle_not_found');
  await rejects(svc.get(e, v.id), 404);
  assert.deepEqual(await svc.list(o, { includeArchived: true }), []);
  await rejects(svc.delete(o, v.id), 404); // already gone
  const last = (await audit(v.id)).at(-1);
  assert.equal(last.action, 'vehicle.delete');
  assert.equal(last.actor_id, o.userId);
});

test('delete refuses an unarchived vehicle until it is archived, and restoring cancels it', { skip }, async () => {
  const o = await user();
  const v = await svc.create(o, { name: 'Keep' });
  await rejects(svc.delete(o, v.id), 409, 'not_archived');
  assert.equal((await svc.get(o, v.id)).name, 'Keep');
  await svc.setArchived(o, v.id, true);
  await svc.setArchived(o, v.id, false);
  await rejects(svc.delete(o, v.id), 409, 'not_archived');
  assert.ok(!(await audit(v.id)).some((r) => r.action === 'vehicle.delete'));
  await svc.setArchived(o, v.id, true);
  await svc.delete(o, v.id);
  await rejects(svc.get(o, v.id), 404);
});

test('delete cascades to everything the vehicle owns and nothing else', { skip }, async () => {
  const o = await user(), m = await user();
  const v = await svc.create(o, { name: 'Cascade' });
  const other = await svc.create(o, { name: 'Bystander' });
  await svc.addMember(o, v.id, m.userId, 'viewer');
  const sql = (t: string, args: unknown[] = []) => pool.query(t, args);
  const seed = async (vid: string) => {
    const visit = uuidv7(), task = uuidv7();
    await sql("INSERT INTO fill_ups (id, vehicle_id, occurred_at, odometer_input, odometer_unit, odometer_km, volume_input, volume_unit, volume_l) VALUES ($1,$2,'2024-01-01T00:00:00Z',1000,'km',1000,40,'l',40)", [uuidv7(), vid]);
    await sql("INSERT INTO vehicle_images (vehicle_id, content_type, data) VALUES ($1,'image/png',$2)", [vid, Buffer.from([1, 2, 3])]);
    await sql("INSERT INTO service_visits (id, vehicle_id, serviced_on, currency) VALUES ($1,$2,'2024-02-01','USD')", [visit, vid]);
    await sql("INSERT INTO service_items (id, visit_id, position, name) VALUES ($1,$2,0,'Oil change')", [uuidv7(), visit]);
    await sql("INSERT INTO service_attachments (id, visit_id, file_name, content_type, size_bytes, sha256, data) VALUES ($1,$2,'r.pdf','application/pdf',3,$3,$4)", [uuidv7(), visit, 'a'.repeat(64), Buffer.from([1, 2, 3])]);
    await sql("INSERT INTO maintenance_tasks (id, vehicle_id, name, interval_days) VALUES ($1,$2,'Rotate tyres',180)", [task, vid]);
    await sql("INSERT INTO task_snoozes (id, task_id, scope, snooze_until_date) VALUES ($1,$2,'vehicle','2030-01-01')", [uuidv7(), task]);
    await sql('INSERT INTO vehicle_notification_settings (vehicle_id) VALUES ($1)', [vid]);
    await sql('INSERT INTO vehicle_comparison_optins (vehicle_id, enabled_by) VALUES ($1,$2)', [vid, o.userId]);
  };
  await seed(v.id);
  await seed(other.id);
  const tables: Array<[string, string]> = [
    ['vehicle_members', 'vehicle_id'], ['fill_ups', 'vehicle_id'], ['vehicle_images', 'vehicle_id'], ['service_visits', 'vehicle_id'],
    ['service_items', 'visit_id IN (SELECT id FROM service_visits WHERE vehicle_id = $1)'],
    ['maintenance_tasks', 'vehicle_id'], ['vehicle_notification_settings', 'vehicle_id'], ['vehicle_comparison_optins', 'vehicle_id'],
  ];
  const counts = async (vid: string) => {
    const out: Record<string, number> = {};
    for (const [t, col] of tables) {
      const where = col.includes('$1') ? col : `${col} = $1`;
      out[t] = (await sql(`SELECT count(*)::int AS n FROM ${t} WHERE ${where}`, [vid])).rows[0].n;
    }
    out['service_attachments'] = (await sql('SELECT count(*)::int AS n FROM service_attachments WHERE visit_id IN (SELECT id FROM service_visits WHERE vehicle_id = $1)', [vid])).rows[0].n;
    out['task_snoozes'] = (await sql('SELECT count(*)::int AS n FROM task_snoozes WHERE task_id IN (SELECT id FROM maintenance_tasks WHERE vehicle_id = $1)', [vid])).rows[0].n;
    return out;
  };
  const before = await counts(v.id);
  const otherBefore = await counts(other.id);
  assert.ok(Object.values(before).every((n) => n > 0), `seed missed a table: ${JSON.stringify(before)}`);
  assert.equal(before['vehicle_members'], 2);

  await svc.setArchived(o, v.id, true);
  await svc.delete(o, v.id);

  assert.ok(Object.values(await counts(v.id)).every((n) => n === 0), JSON.stringify(await counts(v.id)));
  assert.equal((await sql('SELECT count(*)::int AS n FROM vehicles WHERE id = $1', [v.id])).rows[0].n, 0);
  assert.deepEqual(await counts(other.id), otherBefore, 'other vehicles are untouched');
  assert.equal((await svc.get(o, other.id)).name, 'Bystander');
  // Users survive; only the membership goes.
  assert.equal((await sql('SELECT count(*)::int AS n FROM users WHERE id = ANY($1)', [[o.userId, m.userId]])).rows[0].n, 2);
});

test('ownership transfer swaps roles atomically and audits', { skip }, async () => {
  const o = await user(), m = await user(), stranger = await user();
  const v = await svc.create(o, { name: 'Hand over' });
  await rejects(svc.transferOwnership(o, v.id, stranger.userId), 422);
  await rejects(svc.transferOwnership(o, v.id, o.userId), 409, 'already_owner');
  await svc.addMember(o, v.id, m.userId, 'viewer');
  const after = await svc.transferOwnership(o, v.id, m.userId);
  assert.equal(after.role, 'editor');
  assert.equal((await svc.get(m, v.id)).role, 'owner');
  await rejects(svc.transferOwnership(o, v.id, o.userId), 403); // old owner no longer owns it
  const last = (await audit(v.id)).at(-1);
  assert.equal(last.action, 'owner.transfer');
  assert.equal(last.actor_id, o.userId);
});

test('concurrent transfers and removals keep exactly one owner', { skip }, async () => {
  const o = await user(), m1 = await user(), m2 = await user();
  const v = await svc.create(o, { name: 'Race' });
  await svc.addMember(o, v.id, m1.userId, 'editor');
  await svc.addMember(o, v.id, m2.userId, 'editor');
  const results = await Promise.allSettled([
    svc.transferOwnership(o, v.id, m1.userId),
    svc.transferOwnership(o, v.id, m2.userId),
    svc.removeMember(o, v.id, o.userId),
    svc.removeMember(m1, v.id, m1.userId),
  ]);
  const { rows } = await pool.query("SELECT user_id FROM vehicle_members WHERE vehicle_id = $1 AND role = 'owner'", [v.id]);
  assert.equal(rows.length, 1, `owners: ${rows.length}; ${results.map((r) => r.status).join(',')}`);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  // The DB itself refuses a second owner even if the service were bypassed.
  await assert.rejects(pool.query("INSERT INTO vehicle_members (vehicle_id, user_id, role) VALUES ($1,$2,'owner')", [v.id, (await user()).userId]));
});

test('admin recovery is audited, admin-only and grants no routine access', { skip }, async () => {
  const o = await user(), n = await user(), adm = await user('admin'), plain = await user();
  const v = await svc.create(o, { name: 'Recover' });
  await rejects(svc.recoverOwnership(plain, v.id, n.userId, 'lost access'), 404);
  await rejects(svc.recoverOwnership(adm, v.id, n.userId, ''), 422);
  await rejects(svc.recoverOwnership(adm, v.id, (await user('user', 'deleted')).userId, 'lost'), 422);
  await rejects(svc.recoverOwnership(adm, uuidv7(), n.userId, 'lost access'), 404);
  await svc.recoverOwnership(adm, v.id, n.userId, 'owner lost account');
  await rejects(svc.get(adm, v.id), 404); // recovery did not make the admin a member
  assert.equal((await svc.get(n, v.id)).role, 'owner');
  assert.equal((await svc.get(o, v.id)).role, 'editor');
  const last = (await audit(v.id)).at(-1);
  assert.equal(last.action, 'owner.recover');
  assert.equal(last.actor_id, adm.userId);
  assert.equal(last.details.reason, 'owner lost account');
  // A deleted previous owner loses the grant entirely.
  const d = await user(), n2 = await user();
  const v2 = await svc.create(d, { name: 'Orphan' });
  await pool.query("UPDATE users SET status = 'deleted' WHERE id = $1", [d.userId]);
  await svc.recoverOwnership(adm, v2.id, n2.userId, 'account removed');
  const { rows } = await pool.query('SELECT user_id, role FROM vehicle_members WHERE vehicle_id = $1', [v2.id]);
  assert.deepEqual(rows, [{ user_id: n2.userId, role: 'owner' }]);
});
