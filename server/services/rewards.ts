import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import { Outbox, Topic } from '../events/bus.js';
import { applyPoints, rewardedToday } from './points.js';
import { notify } from './notifications.js';
import { audit } from './audit.js';
import { deliverAlerts } from './alerts.js';
import type { StreamerSettings } from './types.js';
import type { VerifiedKickEvent } from '../integrations/kick/types.js';

const kickUser = z.object({
  is_anonymous: z.boolean().optional(),
  user_id: z.union([z.number(), z.string()]).nullable().optional(),
  username: z.string().nullable().optional(),
  profile_picture: z.string().nullable().optional(),
  channel_slug: z.string().nullable().optional(),
});
const subPayload = z.object({ broadcaster: kickUser, subscriber: kickUser, duration: z.number().int().optional() });
const giftPayload = z.object({ broadcaster: kickUser, gifter: kickUser.nullable().optional(), giftees: z.array(kickUser).max(1000) });
const followPayload = z.object({ broadcaster: kickUser, follower: kickUser });
const livePayload = z.object({ broadcaster: kickUser, is_live: z.boolean(), title: z.string().nullable().optional() });

type RewardStatus = 'AWARDED' | 'PENDING_LINK' | 'CAPPED' | 'DISABLED' | 'NONE';

export interface WebhookOutcome {
  status: 'processed' | 'duplicate' | 'ignored' | 'failed';
  webhookEventId?: string;
  error?: string;
}

/**
 * Idempotent Kick webhook processing.
 *  1. The event id (Kick-Event-Message-Id) is inserted with a UNIQUE(provider,
 *     event_id) constraint — a redelivery finds the existing row and is a no-op.
 *  2. Every points credit additionally carries a unique idempotency key
 *     derived from the event id, so even a reprocessed event cannot pay twice.
 *  3. Failed events keep their row (status FAILED) and are atomically
 *     re-claimed on the next delivery or from the admin panel.
 */
export async function handleKickEvent(ctx: AppContext, evt: VerifiedKickEvent): Promise<WebhookOutcome> {
  const inserted = await one<{ id: string }>(
    ctx.db,
    `INSERT INTO webhook_events (provider, event_id, event_type, payload, attempts) VALUES ('kick', $1, $2, $3, 1)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [evt.messageId, evt.type, JSON.stringify(evt.payload)],
  );
  let eventRowId = inserted?.id;
  if (!eventRowId) {
    const reclaimed = await one<{ id: string }>(
      ctx.db,
      `UPDATE webhook_events SET status = 'RECEIVED', attempts = attempts + 1, error = NULL
        WHERE provider = 'kick' AND event_id = $1 AND status = 'FAILED' RETURNING id`,
      [evt.messageId],
    );
    if (!reclaimed) return { status: 'duplicate' };
    eventRowId = reclaimed.id;
  }
  return processStoredKickEvent(ctx, eventRowId, evt.type, evt.payload);
}

export async function processStoredKickEvent(ctx: AppContext, eventRowId: string, type: string, payload: unknown): Promise<WebhookOutcome> {
  const outbox = new Outbox();
  try {
    const status = await ctx.db.tx(async (q) => {
      let handled: 'processed' | 'ignored';
      switch (type) {
        case 'channel.subscription.new':
        case 'channel.subscription.renewal':
          handled = await onSubscription(q, outbox, eventRowId, type === 'channel.subscription.new' ? 'NEW' : 'RENEWAL', subPayload.parse(payload));
          break;
        case 'channel.subscription.gifts':
          handled = await onGifts(q, outbox, eventRowId, giftPayload.parse(payload));
          break;
        case 'channel.followed':
          handled = await onFollow(q, outbox, eventRowId, followPayload.parse(payload));
          break;
        case 'livestream.status.updated':
          handled = await onLiveStatus(q, outbox, livePayload.parse(payload));
          break;
        default:
          handled = 'ignored';
      }
      await q.query(`UPDATE webhook_events SET status = $2, processed_at = now() WHERE id = $1`, [eventRowId, handled === 'processed' ? 'PROCESSED' : 'IGNORED']);
      return handled;
    });
    outbox.flush(ctx.bus);
    // Separate process: points are committed; alerts are best-effort and idempotent.
    await deliverAlerts(ctx, outbox.alerts);
    return { status, webhookEventId: eventRowId };
  } catch (err) {
    const message = err instanceof z.ZodError ? `Invalid payload: ${err.issues.map((i) => i.path.join('.')).join(', ')}` : String((err as Error).message ?? err);
    await ctx.db.query(`UPDATE webhook_events SET status = 'FAILED', error = $2 WHERE id = $1`, [eventRowId, message.slice(0, 1000)]);
    ctx.log.error({ err, eventRowId, type }, 'kick webhook processing failed');
    return { status: 'failed', webhookEventId: eventRowId, error: message };
  }
}

async function channelFor(q: Db, broadcasterId: unknown) {
  if (broadcasterId == null) return null;
  const s = await one<{ id: string; display_name: string; user_id: string }>(
    q,
    `SELECT id, display_name, user_id FROM streamers WHERE kick_broadcaster_user_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'`,
    [String(broadcasterId)],
  );
  if (!s) return null;
  const settings = await one<StreamerSettings>(q, 'SELECT * FROM streamer_settings WHERE streamer_id = $1', [s.id]);
  return { ...s, settings: settings! };
}

async function linkedUser(q: Db, kickUserId: string) {
  return one<{ id: string }>(q, `SELECT u.id FROM kick_accounts k JOIN users u ON u.id = k.user_id WHERE k.kick_user_id = $1 AND u.deleted_at IS NULL`, [kickUserId]);
}

/** Awards points honouring the per-user daily cap. Returns [pointsAwarded, status]. */
async function awardCapped(
  q: Db,
  outbox: Outbox,
  a: { userId: string; streamerId: string; points: number; cap: number; key: string; description: string; refType: string; refId: string },
): Promise<[number, RewardStatus]> {
  if (a.points <= 0) return [0, 'NONE'];
  const already = await rewardedToday(q, a.userId, a.streamerId);
  const room = Math.max(0, a.cap - already);
  const award = Math.min(a.points, room);
  if (award <= 0) return [0, 'CAPPED'];
  await applyPoints(
    q,
    { userId: a.userId, streamerId: a.streamerId, type: 'POINTS_REWARDED', amount: award, description: a.description, referenceType: a.refType, referenceId: a.refId, idempotencyKey: a.key },
    outbox,
  );
  return [award, award < a.points ? 'CAPPED' : 'AWARDED'];
}

async function onSubscription(q: Db, outbox: Outbox, eventRowId: string, kind: 'NEW' | 'RENEWAL', p: z.infer<typeof subPayload>) {
  const ch = await channelFor(q, p.broadcaster.user_id);
  if (!ch || p.subscriber.user_id == null) return 'ignored';
  const kickId = String(p.subscriber.user_id);
  const username = p.subscriber.username ?? 'unknown';
  const points = kind === 'NEW' ? ch.settings.sub_reward_points : ch.settings.resub_reward_points;
  const user = await linkedUser(q, kickId);

  let status: RewardStatus = !ch.settings.rewards_enabled ? 'DISABLED' : points <= 0 ? 'NONE' : user ? 'AWARDED' : 'PENDING_LINK';
  let awarded = 0;
  const sub = await one<{ id: string }>(
    q,
    `INSERT INTO subscriptions (streamer_id, webhook_event_id, kind, kick_user_id, kick_username, user_id, duration_months, reward_points, reward_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ch.id, eventRowId, kind, kickId, username, user?.id ?? null, p.duration ?? 1, status === 'PENDING_LINK' ? points : 0, status],
  );
  if (status === 'AWARDED' && user) {
    [awarded, status] = await awardCapped(q, outbox, {
      userId: user.id,
      streamerId: ch.id,
      points,
      cap: ch.settings.reward_daily_cap_per_user,
      key: `kick:${eventRowId}:${kickId}:sub`,
      description: `${kind === 'NEW' ? 'Subscription' : 'Resubscription'} reward — ${ch.display_name}`,
      refType: 'subscription',
      refId: sub!.id,
    });
    await q.query('UPDATE subscriptions SET reward_points = $2, reward_status = $3 WHERE id = $1', [sub!.id, awarded, status]);
    if (awarded > 0) await notify(q, outbox, user.id, 'subscription.reward', `+${awarded} points for subscribing`, `Thanks for supporting ${ch.display_name}!`, { streamerId: ch.id, points: awarded });
  }
  outbox.push(Topic.channel(ch.id), 'subscription.received', { kind, username, months: p.duration ?? 1, pointsAwarded: awarded, rewardStatus: status });
  outbox.alerts.push({ streamerId: ch.id, kind: 'subscription', sourceType: 'subscription', sourceId: sub!.id, viewerName: username, avatarUrl: p.subscriber.profile_picture ?? null, months: p.duration ?? 1 });
  return 'processed' as const;
}

async function onGifts(q: Db, outbox: Outbox, eventRowId: string, p: z.infer<typeof giftPayload>) {
  const ch = await channelFor(q, p.broadcaster.user_id);
  if (!ch) return 'ignored';
  const s = ch.settings;
  const count = p.giftees.length;
  if (count === 0) return 'ignored';
  const anonymous = !p.gifter || !!p.gifter.is_anonymous || p.gifter.user_id == null;
  const gifterKickId = anonymous ? null : String(p.gifter!.user_id);
  const gifterName = anonymous ? 'Anonymous' : (p.gifter!.username ?? 'unknown');

  // Anti-abuse: cap how many gifts in one event can earn points; bonus for large gifts.
  const rewardable = Math.min(count, s.max_gifts_rewarded_per_event);
  const points = s.gift_reward_points * rewardable + (count >= s.multi_gift_threshold ? s.multi_gift_bonus_points : 0);
  const gifter = gifterKickId ? await linkedUser(q, gifterKickId) : null;
  let status: RewardStatus = anonymous || points <= 0 ? 'NONE' : !s.rewards_enabled ? 'DISABLED' : gifter ? 'AWARDED' : 'PENDING_LINK';

  const gift = await one<{ id: string }>(
    q,
    `INSERT INTO gift_subscriptions (streamer_id, webhook_event_id, gifter_kick_user_id, gifter_username, gifter_user_id, is_anonymous, gift_count, reward_points, reward_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ch.id, eventRowId, gifterKickId, gifterName, gifter?.id ?? null, anonymous, count, status === 'PENDING_LINK' ? points : 0, status],
  );
  let awarded = 0;
  if (status === 'AWARDED' && gifter) {
    [awarded, status] = await awardCapped(q, outbox, {
      userId: gifter.id,
      streamerId: ch.id,
      points,
      cap: s.reward_daily_cap_per_user,
      key: `kick:${eventRowId}:${gifterKickId}:gifter`,
      description: `Gifted ${count} sub${count === 1 ? '' : 's'} — ${ch.display_name}`,
      refType: 'gift_subscription',
      refId: gift!.id,
    });
    await q.query('UPDATE gift_subscriptions SET reward_points = $2, reward_status = $3 WHERE id = $1', [gift!.id, awarded, status]);
    if (awarded > 0) await notify(q, outbox, gifter.id, 'gift_sub.reward', `+${awarded} points for gifting ${count} sub${count === 1 ? '' : 's'}`, `${ch.display_name} appreciates you!`, { streamerId: ch.id, points: awarded });
  }

  // Giftees get their own (smaller) reward, recorded as GIFTED subscriptions.
  for (const g of p.giftees) {
    if (g.user_id == null) continue;
    const kickId = String(g.user_id);
    const user = await linkedUser(q, kickId);
    const pts = s.giftee_reward_points;
    let gStatus: RewardStatus = !s.rewards_enabled ? 'DISABLED' : pts <= 0 ? 'NONE' : user ? 'AWARDED' : 'PENDING_LINK';
    const row = await one<{ id: string }>(
      q,
      `INSERT INTO subscriptions (streamer_id, webhook_event_id, kind, kick_user_id, kick_username, user_id, gift_subscription_id, reward_points, reward_status)
       VALUES ($1,$2,'GIFTED',$3,$4,$5,$6,$7,$8) ON CONFLICT (webhook_event_id, kick_user_id) DO NOTHING RETURNING id`,
      [ch.id, eventRowId, kickId, g.username ?? 'unknown', user?.id ?? null, gift!.id, gStatus === 'PENDING_LINK' ? pts : 0, gStatus],
    );
    if (row && gStatus === 'AWARDED' && user) {
      let got = 0;
      [got, gStatus] = await awardCapped(q, outbox, {
        userId: user.id,
        streamerId: ch.id,
        points: pts,
        cap: s.reward_daily_cap_per_user,
        key: `kick:${eventRowId}:${kickId}:giftee`,
        description: `Received a gifted sub — ${ch.display_name}`,
        refType: 'subscription',
        refId: row.id,
      });
      await q.query('UPDATE subscriptions SET reward_points = $2, reward_status = $3 WHERE id = $1', [row.id, got, gStatus]);
      if (got > 0) await notify(q, outbox, user.id, 'gift_sub.reward', `+${got} points — you were gifted a sub`, `Gifted by ${gifterName} on ${ch.display_name}`, { streamerId: ch.id, points: got });
    }
  }
  outbox.push(Topic.channel(ch.id), 'gift_sub.received', { gifter: gifterName, count, pointsAwarded: awarded, rewardStatus: status });
  outbox.alerts.push({ streamerId: ch.id, kind: 'gift_sub', sourceType: 'gift_subscription', sourceId: gift!.id, viewerName: gifterName, avatarUrl: anonymous ? null : (p.gifter?.profile_picture ?? null), giftCount: count });
  return 'processed' as const;
}

async function onFollow(q: Db, outbox: Outbox, eventRowId: string, p: z.infer<typeof followPayload>) {
  const ch = await channelFor(q, p.broadcaster.user_id);
  if (!ch || p.follower.user_id == null) return 'ignored';
  const pts = ch.settings.follow_reward_points;
  if (!ch.settings.rewards_enabled || pts <= 0) return 'ignored';
  const kickId = String(p.follower.user_id);
  // Once per viewer per channel, ever — unfollow/refollow cannot farm points.
  const first = await one(q, 'INSERT INTO follows_rewarded (streamer_id, kick_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [ch.id, kickId]);
  if (!first) return 'ignored';
  const user = await linkedUser(q, kickId);
  if (!user) return 'processed';
  const [got] = await awardCapped(q, outbox, {
    userId: user.id,
    streamerId: ch.id,
    points: pts,
    cap: ch.settings.reward_daily_cap_per_user,
    key: `kick:${eventRowId}:${kickId}:follow`,
    description: `Follow reward — ${ch.display_name}`,
    refType: 'follow',
    refId: eventRowId,
  });
  if (got > 0) await notify(q, outbox, user.id, 'points.received', `+${got} points for following`, ch.display_name, { streamerId: ch.id, points: got });
  return 'processed';
}

async function onLiveStatus(q: Db, outbox: Outbox, p: z.infer<typeof livePayload>) {
  const ch = await channelFor(q, p.broadcaster.user_id);
  if (!ch) return 'ignored';
  await q.query('UPDATE streamers SET is_live = $2, live_title = $3, live_changed_at = now(), updated_at = now() WHERE id = $1', [ch.id, p.is_live, p.title ?? null]);
  outbox.push([Topic.channel(ch.id), Topic.publicChannel(ch.id)], 'streamer.updated', { streamerId: ch.id, isLive: p.is_live, title: p.title ?? null });
  return 'processed';
}

/**
 * Rewards earned on Kick before the viewer ever signed in here are held as
 * PENDING_LINK and paid out on first login (same idempotency keys, so a
 * reward can never be paid twice).
 */
export async function claimPendingRewards(db: Db, outbox: Outbox, userId: string, kickUserId: string) {
  let total = 0;
  const subs = await many<{ id: string; streamer_id: string; webhook_event_id: string; kind: string; reward_points: number }>(
    db,
    `SELECT id, streamer_id, webhook_event_id, kind, reward_points FROM subscriptions WHERE kick_user_id = $1 AND reward_status = 'PENDING_LINK' FOR UPDATE`,
    [kickUserId],
  );
  for (const s of subs) {
    const role = s.kind === 'GIFTED' ? 'giftee' : 'sub';
    const r = await applyPoints(
      db,
      {
        userId,
        streamerId: s.streamer_id,
        type: 'POINTS_REWARDED',
        amount: s.reward_points,
        description: s.kind === 'GIFTED' ? 'Gifted sub reward (claimed)' : 'Subscription reward (claimed)',
        referenceType: 'subscription',
        referenceId: s.id,
        idempotencyKey: `kick:${s.webhook_event_id}:${kickUserId}:${role}`,
      },
      outbox,
    );
    if (r.applied) total += s.reward_points;
    await db.query(`UPDATE subscriptions SET reward_status = 'AWARDED', user_id = $2 WHERE id = $1`, [s.id, userId]);
  }
  const gifts = await many<{ id: string; streamer_id: string; webhook_event_id: string; reward_points: number; gift_count: number }>(
    db,
    `SELECT id, streamer_id, webhook_event_id, reward_points, gift_count FROM gift_subscriptions WHERE gifter_kick_user_id = $1 AND reward_status = 'PENDING_LINK' FOR UPDATE`,
    [kickUserId],
  );
  for (const g of gifts) {
    const r = await applyPoints(
      db,
      {
        userId,
        streamerId: g.streamer_id,
        type: 'POINTS_REWARDED',
        amount: g.reward_points,
        description: `Gifted ${g.gift_count} sub${g.gift_count === 1 ? '' : 's'} (claimed)`,
        referenceType: 'gift_subscription',
        referenceId: g.id,
        idempotencyKey: `kick:${g.webhook_event_id}:${kickUserId}:gifter`,
      },
      outbox,
    );
    if (r.applied) total += g.reward_points;
    await db.query(`UPDATE gift_subscriptions SET reward_status = 'AWARDED', gifter_user_id = $2 WHERE id = $1`, [g.id, userId]);
  }
  if (total > 0) {
    await notify(db, outbox, userId, 'points.received', `+${total} points from Kick rewards`, 'Rewards you earned before joining were added to your balance.', { points: total });
    await audit(db, { actorUserId: userId, action: 'rewards.claimed', entityType: 'user', entityId: userId, metadata: { points: total } });
  }
  return total;
}
