import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { isUniqueViolation, many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { Outbox, Topic } from '../events/bus.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import type { SessionUser } from './types.js';

export interface Restriction {
  id: string;
  kind: 'BAN' | 'MUTE';
  scope: 'channel' | 'platform';
  reason: string;
  expires_at: Date | null;
}

/** Active ban/mute for a user on a channel (or platform-wide). */
export async function activeRestriction(db: Db, streamerId: string, userId: string): Promise<Restriction | null> {
  const r = await one<{ id: string; kind: 'BAN' | 'MUTE'; streamer_id: string | null; reason: string; expires_at: Date | null }>(
    db,
    `SELECT id, kind, streamer_id, reason, expires_at FROM bans
      WHERE user_id = $2 AND (streamer_id = $1 OR streamer_id IS NULL)
        AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      ORDER BY (kind = 'BAN') DESC, expires_at DESC NULLS FIRST LIMIT 1`,
    [streamerId, userId],
  );
  return r ? { id: r.id, kind: r.kind, scope: r.streamer_id ? 'channel' : 'platform', reason: r.reason, expires_at: r.expires_at } : null;
}

export async function recordModAction(
  db: Db,
  a: { streamerId: string | null; actorId: string; targetUserId?: string | null; messageId?: string | null; action: string; reason?: string },
) {
  await db.query(
    `INSERT INTO moderation_actions (streamer_id, actor_id, target_user_id, message_id, action, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [a.streamerId, a.actorId, a.targetUserId ?? null, a.messageId ?? null, a.action, (a.reason ?? '').slice(0, 300)],
  );
}

type UserAction = 'WARN' | 'MUTE' | 'UNMUTE' | 'BAN' | 'UNBAN';

/**
 * Warn / mute / ban / unban a viewer on a channel. Owners and moderators may
 * act; nobody can act on the channel owner or on themselves.
 */
export async function moderateUser(
  ctx: AppContext,
  actor: SessionUser,
  streamerId: string,
  targetUserId: string,
  action: UserAction,
  opts: { reason?: string; minutes?: number; ipHash?: string | null } = {},
  rejectPending?: (q: Db, outbox: Outbox, streamerId: string, userId: string, actor: SessionUser) => Promise<number>,
) {
  const reason = cleanText(opts.reason ?? '', 300);
  const outbox = new Outbox();
  const result = await ctx.db.tx(async (q) => {
    const target = await one<{ id: string; username: string }>(q, 'SELECT id, username FROM users WHERE id = $1 AND deleted_at IS NULL', [targetUserId]);
    if (!target) throw Errors.notFound('User');
    if (target.id === actor.id) throw Errors.badRequest('You cannot moderate yourself');
    const owner = await one<{ user_id: string }>(q, 'SELECT user_id FROM streamers WHERE id = $1', [streamerId]);
    if (owner?.user_id === target.id) throw Errors.forbidden('The channel owner cannot be moderated');

    let cancelled = 0;
    switch (action) {
      case 'WARN':
        await notify(q, outbox, target.id, 'moderation.warning', 'You received a warning', reason || 'Please follow the channel rules.', { streamerId });
        outbox.push(Topic.channel(streamerId), 'user.warned', { userId: target.id, reason });
        break;
      case 'MUTE':
      case 'BAN': {
        const minutes = action === 'MUTE' ? (opts.minutes ?? 10) : opts.minutes;
        if (action === 'MUTE' && (!minutes || minutes < 1 || minutes > 43200)) throw Errors.validation('Mute duration must be 1 minute – 30 days');
        // Replace any existing active restriction of the same kind.
        await q.query(`UPDATE bans SET lifted_at = now(), lifted_by = $3 WHERE streamer_id = $1 AND user_id = $2 AND kind = $4 AND lifted_at IS NULL`, [
          streamerId,
          target.id,
          actor.id,
          action,
        ]);
        try {
          await q.query(
            `INSERT INTO bans (streamer_id, user_id, kind, reason, created_by, expires_at)
             VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(mins => $6::int) END)`,
            [streamerId, target.id, action, reason, actor.id, minutes ?? null],
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw Errors.conflict('User already has an active restriction');
          throw err;
        }
        if (rejectPending) cancelled = await rejectPending(q, outbox, streamerId, target.id, actor);
        await notify(
          q,
          outbox,
          target.id,
          'moderation.banned',
          action === 'BAN' ? 'You were banned from a channel' : `You were muted for ${minutes} minutes`,
          reason,
          { streamerId, kind: action },
        );
        outbox.push(Topic.channel(streamerId), 'user.banned', { userId: target.id, kind: action, minutes: minutes ?? null, reason });
        break;
      }
      case 'UNMUTE':
      case 'UNBAN': {
        const kind = action === 'UNBAN' ? 'BAN' : 'MUTE';
        const r = await q.query(`UPDATE bans SET lifted_at = now(), lifted_by = $3 WHERE streamer_id = $1 AND user_id = $2 AND kind = $4 AND lifted_at IS NULL`, [
          streamerId,
          target.id,
          actor.id,
          kind,
        ]);
        if (!r.rowCount) throw Errors.notFound(kind === 'BAN' ? 'Active ban' : 'Active mute');
        break;
      }
    }
    await recordModAction(q, { streamerId, actorId: actor.id, targetUserId: target.id, action, reason });
    await audit(q, {
      actorUserId: actor.id,
      streamerId,
      action: `user.${action.toLowerCase()}`,
      entityType: 'user',
      entityId: target.id,
      metadata: { reason, minutes: opts.minutes ?? null, cancelledMessages: cancelled },
      ipHash: opts.ipHash ?? null,
    });
    return { ok: true, cancelledMessages: cancelled };
  });
  outbox.flush(ctx.bus);
  return result;
}

export async function listBans(db: Db, streamerId: string) {
  return many(
    db,
    `SELECT b.id, b.kind, b.reason, b.created_at, b.expires_at, u.id AS user_id, u.username, u.display_name, u.avatar_url, a.username AS created_by_username
       FROM bans b JOIN users u ON u.id = b.user_id JOIN users a ON a.id = b.created_by
      WHERE b.streamer_id = $1 AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now())
      ORDER BY b.created_at DESC LIMIT 500`,
    [streamerId],
  );
}
