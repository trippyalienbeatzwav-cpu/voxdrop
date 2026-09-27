import type { Db } from '../db/client.js';
import { one } from '../db/client.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { SessionUser } from '../services/types.js';

export const SESSION_COOKIE = 'vx_session';
export const OAUTH_COOKIE = 'vx_oauth';
export const SESSION_TTL_DAYS = 30;

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: Date;
  last_seen_at: Date;
}

/**
 * Opaque random session tokens; only their SHA-256 is stored, so a database
 * leak does not yield usable sessions. Each session carries its own CSRF token.
 */
export async function createSession(db: Db, userId: string, meta: { ipHash: string | null; userAgent: string | null }) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const row = await one<SessionRow>(
    db,
    `INSERT INTO sessions (user_id, token_hash, csrf_token, ip_hash, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) RETURNING id, user_id, csrf_token, expires_at, last_seen_at`,
    [userId, sha256(token), csrf, meta.ipHash, (meta.userAgent ?? '').slice(0, 300), SESSION_TTL_DAYS],
  );
  return { token, session: row! };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<{ session: SessionRow; user: SessionUser } | null> {
  if (!token || token.length > 100) return null;
  const row = await one<SessionRow & { u_id: string; username: string; display_name: string; avatar_url: string | null; role: SessionUser['role']; status: SessionUser['status']; reduced_motion: boolean }>(
    db,
    `SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.last_seen_at,
            u.id AS u_id, u.username, u.display_name, u.avatar_url, u.role, u.status, u.reduced_motion
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [sha256(token)],
  );
  if (!row) return null;
  // Sliding expiry, written at most every 10 minutes to keep hot paths read-only.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60 * 1000) {
    await db.query(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`, [row.id, SESSION_TTL_DAYS]);
  }
  return {
    session: { id: row.id, user_id: row.user_id, csrf_token: row.csrf_token, expires_at: row.expires_at, last_seen_at: row.last_seen_at },
    user: { id: row.u_id, username: row.username, display_name: row.display_name, avatar_url: row.avatar_url, role: row.role, status: row.status, reduced_motion: row.reduced_motion },
  };
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessions(db: Db, userId: string, exceptSessionId?: string) {
  const r = await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [userId, exceptSessionId ?? null]);
  return r.rowCount;
}
