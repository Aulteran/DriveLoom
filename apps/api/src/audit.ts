// The one place that writes audit_events. Every audit row in the code base goes through here so that
// a change made with an API key is always attributed to the key (id and name at the time), and so the
// owner-visible key history (api_key_activity) is written in the same transaction as the change.
//
// Rules: pass the transaction's client for anything that changes data, so the audit row and the key
// history commit or roll back with the change. Never put tokens, payloads or receipt content in `details`;
// admins read it verbatim (GET /v1/admin/audit) and the key owner reads the history.
import type pg from 'pg';
import { recordKeyActivity } from './auth/api-keys.ts';
import { insertAudit } from './audit-insert.ts';
import type { Principal } from './identity.ts';
import type { Id } from './types.ts';

type Q = Pick<pg.Pool, 'query'>;

export { insertAudit };

export interface PrincipalAudit {
  action: string;
  subjectType: 'user' | 'vehicle';
  subjectId: Id;
  details?: Record<string, unknown>;
  /** What the change touched, for the key's history. Defaults to the subject. */
  target?: { type: string; ids: Id[] };
  /** False for events that are reads (an export): they are audited for sessions as before but never recorded as key activity. */
  keyActivity?: boolean;
  at?: Date;
}

const MAX_METADATA_BYTES = 2000;

/**
 * Audit a change made by `p`. For an API key the row also carries the key's id and name, and a successful
 * change is recorded in the key's history inside the same transaction (`q`).
 */
export async function auditAs(q: Q, p: Principal, e: PrincipalAudit): Promise<void> {
  const key = p.kind === 'api_key' ? p.apiKey : null;
  const details = { ...(e.details ?? {}), ...(key ? { apiKey: { id: key.id, name: key.name } } : {}) };
  await insertAudit(q, { actor: p.userId, action: e.action, subjectType: e.subjectType, subjectId: e.subjectId, details, ...(e.at ? { at: e.at } : {}) });
  if (key && e.keyActivity !== false) {
    const meta = e.details && JSON.stringify(e.details).length <= MAX_METADATA_BYTES ? e.details : {};
    await recordKeyActivity(q, {
      keyId: key.id, userId: p.userId, keyName: key.name, action: e.action,
      targetType: e.target?.type ?? e.subjectType, targetIds: e.target?.ids ?? [e.subjectId],
      vehicleId: e.subjectType === 'vehicle' ? e.subjectId : null, requestId: key.requestId, metadata: meta, ...(e.at ? { at: e.at } : {}),
    });
  }
}
