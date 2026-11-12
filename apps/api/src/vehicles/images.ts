// Vehicle images: private, one per vehicle, readable by members only. The type
// is decided from the file's leading bytes, never from what the client claims.
import type pg from 'pg';
import type { HttpRequest, RawBody, Route } from '../http/app.ts';
import { HttpProblem } from '../http/problem.ts';
import { requirePrincipal } from '../identity.ts';
import { uuidv7 } from '../ids.ts';
import type { VehicleService } from './service.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function sniffImage(b: Buffer): (typeof TYPES)[number] | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function imageRoutes(pool: pg.Pool, vehicles: VehicleService): Route[] {
  const who = (r: HttpRequest) => requirePrincipal(r.ctx);
  const path = '/v1/vehicles/:vehicleId/image';
  const write = async <T>(r: HttpRequest, action: string, fn: (c: pg.PoolClient, vehicleId: string) => Promise<T>): Promise<T> => {
    const p = who(r);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const v = await vehicles.access(c, p, r.params['vehicleId'], true);
      if (v.role === 'viewer') throw new HttpProblem(403, 'forbidden', 'Forbidden', 'Your role does not allow changing the image.');
      if (v.archived) throw new HttpProblem(409, 'vehicle_archived', 'Conflict', 'This vehicle is archived.');
      const out = await fn(c, v.id);
      await c.query("INSERT INTO audit_events (id, actor_id, action, subject_type, subject_id) VALUES ($1,$2,$3,'vehicle',$4)", [uuidv7(), p.userId, action, v.id]);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  };
  return [
    { method: 'GET', path, async handler(r) {
      const v = await vehicles.access(pool, who(r), r.params['vehicleId']);
      const { rows } = await pool.query<{ content_type: string; data: Buffer }>('SELECT content_type, data FROM vehicle_images WHERE vehicle_id = $1', [v.id]);
      if (!rows[0]) throw new HttpProblem(404, 'image_not_found', 'This vehicle has no image');
      return {
        status: 200, raw: { data: rows[0].data, contentType: rows[0].content_type },
        // Never rendered as a document: no scripts, no framing, no sniffing.
        headers: { 'cache-control': r.query.has('v') ? 'private, max-age=86400' : 'private, no-cache', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' },
      };
    } },
    { method: 'PUT', path, rawBody: { types: TYPES, maxBytes: MAX_IMAGE_BYTES }, async handler(r) {
      const body = r.body as RawBody;
      const type = sniffImage(body.data);
      if (!type) throw new HttpProblem(422, 'validation_failed', 'Validation failed', 'The file is not a JPEG, PNG or WebP image.');
      await write(r, 'vehicle.image_set', (c, id) => c.query(
        `INSERT INTO vehicle_images (vehicle_id, content_type, data, uploaded_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (vehicle_id) DO UPDATE SET content_type = $2, data = $3, uploaded_by = $4, updated_at = now()`, [id, type, body.data, who(r).userId]));
      return { status: 204 };
    } },
    { method: 'DELETE', path, async handler(r) {
      const n = await write(r, 'vehicle.image_remove', async (c, id) => (await c.query('DELETE FROM vehicle_images WHERE vehicle_id = $1', [id])).rowCount);
      if (!n) throw new HttpProblem(404, 'image_not_found', 'This vehicle has no image');
      return { status: 204 };
    } },
  ];
}
