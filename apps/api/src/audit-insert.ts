// The single raw INSERT into audit_events. Kept dependency-free so any module can import it; call sites use audit.ts (auditAs)
// or auth/context.ts (audit) rather than this directly.
import type pg from 'pg';
import { uuidv7 } from './ids.ts';
import type { Id } from './types.ts';

export interface AuditRow {
  actor: Id | null;
  action: string;
  subjectType: 'user' | 'vehicle' | null;
  subjectId: Id | null;
  details?: Record<string, unknown>;
  at?: Date;
}

/** Low level insert. Prefer `auditAs` when a principal made the change. */
export async function insertAudit(q: Pick<pg.Pool, 'query'>, row: AuditRow): Promise<void> {
  await q.query('INSERT INTO audit_events (id, occurred_at, actor_id, action, subject_type, subject_id, details) VALUES ($1,COALESCE($2::timestamptz, now()),$3,$4,$5,$6,$7)',
    [uuidv7(), row.at ?? null, row.actor, row.action, row.subjectType, row.subjectId, JSON.stringify(row.details ?? {})]);
}

