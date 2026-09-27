import type { Db } from '../db/client.js';

export interface AuditEntry {
  actorUserId: string | null;
  streamerId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/** Appends to the immutable audit log (UPDATE/DELETE are blocked by a trigger). */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, streamer_id, action, entity_type, entity_id, metadata, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.actorUserId, e.streamerId ?? null, e.action, e.entityType, e.entityId ?? null, JSON.stringify(e.metadata ?? {}), e.ipHash ?? null],
  );
}
