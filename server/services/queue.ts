import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { Outbox, Topic } from '../events/bus.js';
import { applyPoints } from './points.js';
import { notify } from './notifications.js';
import { audit } from './audit.js';
import { recordModAction } from './moderation.js';
import { getSettings } from './streamers.js';
import { getMessageView, getMessageViews, playDurationMs, toMessageView } from './messageView.js';
import { announcementKind, ESTIMATED_ANNOUNCEMENT_MS, isEligible, prepareItem } from './announcements.js';
import { getPriorityConfig, orderQueue, type QueueCandidate, type TierKey } from './priority.js';
import type { MessageViewRow } from './messageView.js';
import type { MessageRow, SessionUser } from './types.js';

const ACTIVE_QUEUE = `('QUEUED','PLAYING')`;

/**
 * Adds an approved message to its channel's playback queue. Where it actually
 * plays is decided dynamically by the priority engine (tier, points, waiting time).
 */
export async function enqueue(q: Db, outbox: Outbox, msg: Pick<MessageRow, 'id' | 'streamer_id' | 'sender_id' | 'is_priority'> & { priority_tier?: string }) {
  const pos = await one<{ p: number }>(q, `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM playback_queue WHERE streamer_id = $1`, [msg.streamer_id]);
  const item = await one<{ id: string }>(
    q,
    `INSERT INTO playback_queue (streamer_id, message_id, position, is_priority, priority_tier) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [msg.streamer_id, msg.id, pos!.p, msg.is_priority, msg.priority_tier ?? 'NORMAL'],
  );
  await q.query(`UPDATE messages SET status = 'QUEUED', updated_at = now() WHERE id = $1`, [msg.id]);
  outbox.push([Topic.channel(msg.streamer_id), Topic.user(msg.sender_id)], 'message.queued', { messageId: msg.id, streamerId: msg.streamer_id });
  outbox.push([Topic.channel(msg.streamer_id), Topic.user(msg.sender_id)], 'queue.added', { messageId: msg.id, itemId: item!.id, streamerId: msg.streamer_id, tier: msg.priority_tier ?? 'NORMAL' });
  outbox.push([Topic.channel(msg.streamer_id), Topic.publicChannel(msg.streamer_id)], 'queue.updated', { streamerId: msg.streamer_id });
}

/**
 * Refunds a message's points (idempotent per part). The normal price and the
 * priority premium are separate ledger entries, so they can be refunded
 * independently (channel settings decide what a rejection refunds).
 */
export async function refundMessage(
  q: Db,
  outbox: Outbox,
  msg: Pick<MessageRow, 'id' | 'sender_id' | 'streamer_id' | 'points_spent'> & { priority_points?: number; priority_tier?: string },
  why: string,
  parts: { base?: boolean; priority?: boolean } = { base: true, priority: true },
) {
  const premium = Math.min(msg.priority_points ?? 0, msg.points_spent);
  const base = msg.points_spent - premium;
  let applied = false;
  if (parts.base !== false && base > 0) {
    const r = await applyPoints(
      q,
      { userId: msg.sender_id, streamerId: msg.streamer_id, type: 'POINTS_REFUNDED', amount: base, description: `Refund: ${why}`, referenceType: 'message', referenceId: msg.id, idempotencyKey: `refund:message:${msg.id}` },
      outbox,
    );
    applied = applied || r.applied;
  }
  if (parts.priority !== false && premium > 0) {
    const r = await applyPoints(
      q,
      {
        userId: msg.sender_id,
        streamerId: msg.streamer_id,
        type: 'POINTS_REFUNDED',
        amount: premium,
        description: `Priority refund (${msg.priority_tier ?? 'priority'}): ${why}`,
        referenceType: 'message',
        referenceId: msg.id,
        idempotencyKey: `refund:priority:${msg.id}`,
        priorityTier: msg.priority_tier ?? null,
      },
      outbox,
    );
    applied = applied || r.applied;
  }
  return applied;
}

/** Duration of one playback item including its (estimated) name announcement. */
function itemDurationMs(ctx: AppContext, r: MessageViewRow, settings: Awaited<ReturnType<typeof getSettings>>, ownerId: string) {
  const kind = announcementKind(r, ownerId);
  const st = r.announcement_status;
  const announced = st === 'READY' || st === 'PLAYED' || st === 'PENDING' || (st === 'NONE' && isEligible(settings, kind, ctx.tts.available));
  const announceMs = announced ? (r.announcement_duration_ms ?? ESTIMATED_ANNOUNCEMENT_MS) : 0;
  return { durationMs: playDurationMs(r, settings.alert_duration_ms) + announceMs, announced, kind };
}

const candidateOf = (r: MessageViewRow): QueueCandidate => ({
  id: r.queue_item_id!,
  tier: (r.priority_tier ?? 'NORMAL') as TierKey,
  pointsSpent: r.points_spent,
  enqueuedAt: new Date(r.queue_enqueued_at!),
  pinnedRank: r.queue_pinned_rank,
  isPriority: !!r.queue_priority,
  position: Number(r.queue_raw_position ?? 0),
});

/**
 * The single source of truth for playback order and ETAs (used by playNext,
 * the streamer's live queue, viewers' positions and pre-purchase estimates).
 */
export async function computeQueue(ctx: AppContext, streamerId: string, hypothetical?: { tier: TierKey; points: number }) {
  const settings = await getSettings(ctx.db, streamerId);
  const prio = await getPriorityConfig(ctx.db, streamerId);
  const streamer = await one<{ queue_paused: boolean; user_id: string }>(ctx.db, 'SELECT queue_paused, user_id FROM streamers WHERE id = $1', [streamerId]);
  const rows = await getMessageViews(ctx.db, `m.streamer_id = $1 AND q.status IN ${ACTIVE_QUEUE}`, [streamerId], `LIMIT 1000`);
  const now = new Date();
  const playingRow = rows.find((r) => r.queue_status === 'PLAYING') ?? null;
  const queued = rows.filter((r) => r.queue_status === 'QUEUED');
  const byId = new Map(queued.map((r) => [r.queue_item_id!, r]));
  const candidates = queued.map(candidateOf);
  const HYPO = '00000000-0000-0000-0000-00000000ffff';
  if (hypothetical) candidates.push({ id: HYPO, tier: hypothetical.tier, pointsSpent: hypothetical.points, enqueuedAt: now, pinnedRank: null, isPriority: hypothetical.tier !== 'NORMAL', position: Number.MAX_SAFE_INTEGER });
  const ordered = orderQueue(candidates, prio.settings, prio.tierMap, now);

  let wait = 0;
  let nowPlaying = null;
  if (playingRow) {
    const d = itemDurationMs(ctx, playingRow, settings, streamer!.user_id);
    const elapsed = playingRow.queue_started_at ? now.getTime() - new Date(playingRow.queue_started_at).getTime() : 0;
    wait = Math.max(0, d.durationMs - elapsed) + settings.playback_gap_ms;
    nowPlaying = decorate(playingRow, d, 0, 0, null, now);
  }
  let hypotheticalResult: { position: number; ahead: number; estimatedWaitMs: number } | null = null;
  const items = [];
  for (let i = 0; i < ordered.length; i++) {
    const o = ordered[i]!;
    if (o.id === HYPO) {
      hypotheticalResult = { position: i + 1, ahead: i + (playingRow ? 1 : 0), estimatedWaitMs: Math.round(wait) };
      continue;
    }
    const r = byId.get(o.id)!;
    const d = itemDurationMs(ctx, r, settings, streamer!.user_id);
    items.push(decorate(r, d, items.length + 1, Math.round(wait), o.priority, now));
    wait += d.durationMs + settings.playback_gap_ms;
  }
  return {
    settings,
    priority: prio,
    paused: streamer?.queue_paused ?? false,
    nowPlaying,
    items,
    totalWaitMs: Math.round(wait),
    hypothetical: hypotheticalResult,
  };
}

function decorate(r: MessageViewRow, d: { durationMs: number; announced: boolean; kind: string | null }, position: number, estimatedWaitMs: number, priority: ReturnType<typeof orderQueue>[number]['priority'] | null, now: Date) {
  return {
    ...toMessageView(r),
    viewerName: r.donation_anonymous ? 'Anonymous' : (r.kick_username ?? r.sender_display_name),
    announcementEnabled: d.announced,
    announcementKind: d.kind,
    queuePosition: position,
    durationMs: d.durationMs,
    estimatedWaitMs,
    waitingSeconds: r.queue_enqueued_at ? Math.max(0, Math.round((now.getTime() - new Date(r.queue_enqueued_at).getTime()) / 1000)) : 0,
    pinned: r.queue_pinned_rank !== null,
    priorityScore: priority,
  };
}

export async function getQueue(ctx: AppContext, streamerId: string) {
  const c = await computeQueue(ctx, streamerId);
  return {
    paused: c.paused,
    autoPlay: c.settings.auto_play,
    autoPlayDelayMs: c.settings.playback_gap_ms,
    overlayConnected: ctx.bus.listenerCount(Topic.overlay(streamerId)) > 0,
    announcements: { enabled: c.settings.announce_enabled, types: c.settings.announce_types, available: ctx.tts.available, provider: ctx.tts.name },
    priority: { enabled: c.priority.settings.enabled, allowVipInterrupt: c.priority.settings.allow_vip_interrupt, tiers: c.priority.tiers },
    nowPlaying: c.nowPlaying,
    items: c.items,
    totalWaitMs: c.totalWaitMs,
  };
}

/** A viewer's live position for one of their messages (null when it is not waiting). */
export async function positionOf(ctx: AppContext, streamerId: string, messageId: string) {
  const c = await computeQueue(ctx, streamerId);
  if (c.nowPlaying?.id === messageId) return { messageId, position: 0, ahead: 0, estimatedWaitMs: 0, tier: c.nowPlaying.priorityTier, state: c.nowPlaying.playbackState, queueLength: c.items.length };
  const it = c.items.find((i) => i.id === messageId);
  if (!it) return null;
  return { messageId, position: it.queuePosition, ahead: it.queuePosition - 1 + (c.nowPlaying ? 1 : 0), estimatedWaitMs: it.estimatedWaitMs, tier: it.priorityTier, state: it.playbackState, queueLength: c.items.length };
}

// Positions are pushed to each waiting viewer whenever the order may have changed (debounced per channel).
const positionTimers = new Map<string, NodeJS.Timeout>();
const lastPositions = new Map<string, string>();
export function schedulePositions(ctx: AppContext, streamerId: string) {
  if (positionTimers.has(streamerId)) return;
  positionTimers.set(
    streamerId,
    setTimeout(() => {
      positionTimers.delete(streamerId);
      void publishPositions(ctx, streamerId).catch((err) => ctx.log.warn({ err }, 'position publish failed'));
    }, 150),
  );
}

export async function publishPositions(ctx: AppContext, streamerId: string) {
  const c = await computeQueue(ctx, streamerId);
  const ahead = c.nowPlaying ? 1 : 0;
  for (const it of c.items) {
    if (!it.sender.id) continue;
    const payload = { messageId: it.id, streamerId, position: it.queuePosition, ahead: it.queuePosition - 1 + ahead, estimatedWaitMs: it.estimatedWaitMs, tier: it.priorityTier, queueLength: c.items.length };
    const sig = `${payload.position}|${payload.ahead}|${Math.round(payload.estimatedWaitMs / 5000)}`;
    if (lastPositions.get(it.id) === sig) continue;
    lastPositions.set(it.id, sig);
    ctx.bus.publish(Topic.user(it.sender.id), 'queue.position_changed', payload);
  }
}

/** Payload the OBS overlay needs to render + play an item. */
export async function overlayPayload(ctx: AppContext, messageId: string, itemId: string) {
  const v = await getMessageView(ctx.db, messageId);
  const s = await getSettings(ctx.db, v!.streamerId);
  const a = v!.queue?.announcement;
  return {
    itemId,
    phase: v!.queue?.phase ?? 'PENDING',
    message: v,
    /** Present only when an announcement is ready to play before the viewer's audio. */
    announcement: a && a.audioId && (a.status === 'READY' || a.status === 'PLAYED') ? { audioId: a.audioId, text: a.text, durationMs: a.durationMs, played: a.status === 'PLAYED' } : null,
    announcementVolume: s.announce_volume,
    durationMs: playDurationMs(
      { type: v!.type, audio_duration_ms: v!.type === 'SOUND' ? null : (v!.audio?.durationMs ?? null), sound_duration_ms: v!.type === 'SOUND' ? (v!.audio?.durationMs ?? null) : null },
      s.alert_duration_ms,
    ),
    volume: s.playback_volume,
  };
}

/** Highest-priority QUEUED item right now (called under the channel row lock). */
async function nextInOrder(q: Db, streamerId: string) {
  const rows = await q.query<{ id: string; message_id: string; priority_tier: TierKey; points_spent: number; enqueued_at: Date; pinned_rank: number | null; is_priority: boolean; position: number }>(
    `SELECT pq.id, pq.message_id, m.priority_tier, m.points_spent, pq.enqueued_at, pq.pinned_rank, pq.is_priority, pq.position
       FROM playback_queue pq JOIN messages m ON m.id = pq.message_id
      WHERE pq.streamer_id = $1 AND pq.status = 'QUEUED'`,
    [streamerId],
  );
  if (!rows.rows.length) return null;
  const prio = await getPriorityConfig(q, streamerId);
  const ordered = orderQueue(
    rows.rows.map((r) => ({ id: r.id, tier: r.priority_tier, pointsSpent: r.points_spent, enqueuedAt: new Date(r.enqueued_at), pinnedRank: r.pinned_rank, isPriority: r.is_priority, position: Number(r.position), message_id: r.message_id })),
    prio.settings,
    prio.tierMap,
  );
  return { id: ordered[0]!.id, message_id: ordered[0]!.message_id };
}

/**
 * Optional (default OFF): a VIP item may cut in. The interrupted item is not
 * lost — it goes back to the queue pinned right behind the VIP item and replays
 * from its announcement. Never interrupts another VIP item.
 */
export async function maybeInterruptForVip(ctx: AppContext, streamerId: string) {
  const prio = await getPriorityConfig(ctx.db, streamerId);
  if (!prio.settings.enabled || !prio.settings.allow_vip_interrupt) return false;
  const outbox = new Outbox();
  const done = await ctx.db.tx(async (q) => {
    await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [streamerId]);
    const current = await one<{ id: string; message_id: string; priority_tier: string; sender_id: string }>(
      q,
      `SELECT pq.id, pq.message_id, pq.priority_tier, m.sender_id FROM playback_queue pq JOIN messages m ON m.id = pq.message_id WHERE pq.streamer_id = $1 AND pq.status = 'PLAYING'`,
      [streamerId],
    );
    if (!current || current.priority_tier === 'VIP') return false;
    const next = await nextInOrder(q, streamerId);
    if (!next) return false;
    const nextTier = await one<{ priority_tier: string }>(q, 'SELECT priority_tier FROM playback_queue WHERE id = $1', [next.id]);
    if (nextTier?.priority_tier !== 'VIP') return false;
    await q.query(
      `UPDATE playback_queue SET status = 'QUEUED', phase = 'PENDING', started_at = NULL, pinned_rank = -1000000, announcement_started_at = NULL, announcement_finished_at = NULL,
              message_started_at = NULL, announcement_status = CASE WHEN announcement_audio_file_id IS NOT NULL THEN 'READY' ELSE 'NONE' END
        WHERE id = $1`,
      [current.id],
    );
    await q.query('UPDATE playback_queue SET pinned_rank = -1000001 WHERE id = $1', [next.id]);
    await q.query(`UPDATE messages SET status = 'QUEUED', updated_at = now() WHERE id = $1`, [current.message_id]);
    await audit(q, { actorUserId: null, streamerId, action: 'queue.vip_interrupt', entityType: 'playback_queue', entityId: current.id, metadata: { interruptedBy: next.id } });
    outbox.push(Topic.overlay(streamerId), 'overlay.stop', { itemId: current.id });
    outbox.push([Topic.channel(streamerId), Topic.user(current.sender_id)], 'message.updated', { messageId: current.message_id, status: 'QUEUED', interrupted: true });
    return true;
  });
  outbox.flush(ctx.bus);
  if (done) await playNext(ctx, streamerId, null, { force: false });
  return done;
}

const timers = new Map<string, NodeJS.Timeout>();
export function clearQueueTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

const warming = new Set<string>();
/** Background pre-generation of upcoming announcements (one runner per channel). */
export function warm(ctx: AppContext, streamerId: string) {
  if (warming.has(streamerId) || !ctx.tts.available) return;
  warming.add(streamerId);
  void (async () => {
    // Pre-generate announcements for the next few items in actual playback order.
    const c = await computeQueue(ctx, streamerId);
    for (const it of c.items.slice(0, 5)) {
      if (it.queue?.announcement.status === 'NONE' && it.announcementEnabled) await prepareItem(ctx, it.queue.itemId);
    }
  })()
    .catch((err) => ctx.log.warn({ err }, 'announcement warm-up failed'))
    .finally(() => warming.delete(streamerId));
}

function overlayOnline(ctx: AppContext, streamerId: string) {
  return ctx.bus.listenerCount(Topic.overlay(streamerId)) > 0;
}

/** Starts the next item if auto-play is on, the queue is not paused, and an overlay is listening. */
export async function tryAdvance(ctx: AppContext, streamerId: string, delayMs = 0) {
  warm(ctx, streamerId);
  if (timers.has(streamerId)) return;
  const run = async () => {
    timers.delete(streamerId);
    try {
      const s = await one<{ queue_paused: boolean; auto_play: boolean }>(
        ctx.db,
        'SELECT s.queue_paused, ss.auto_play FROM streamers s JOIN streamer_settings ss ON ss.streamer_id = s.id WHERE s.id = $1',
        [streamerId],
      );
      if (!s || s.queue_paused || !s.auto_play || !overlayOnline(ctx, streamerId)) return;
      if (await maybeInterruptForVip(ctx, streamerId)) return;
      await playNext(ctx, streamerId, null, { force: false });
    } catch (err) {
      ctx.log.error({ err, streamerId }, 'auto-advance failed');
    }
  };
  if (delayMs <= 0) return run();
  timers.set(streamerId, setTimeout(run, delayMs));
}

/**
 * Starts the next queued item. The streamer row lock serialises all queue
 * transitions for a channel, and the partial unique index guarantees there is
 * never more than one PLAYING item — overlapping playback is impossible.
 */
export async function playNext(ctx: AppContext, streamerId: string, actor: SessionUser | null, opts: { force?: boolean } = {}) {
  const outbox = new Outbox();
  const started = await ctx.db.tx(async (q) => {
    await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [streamerId]);
    const current = await one<{ id: string; message_id: string }>(q, `SELECT id, message_id FROM playback_queue WHERE streamer_id = $1 AND status = 'PLAYING'`, [streamerId]);
    if (current) {
      if (!opts.force) return null;
      await finishInTx(q, outbox, streamerId, current.id, 'SKIPPED', actor);
    }
    const next = await nextInOrder(q, streamerId);
    if (!next) return null;
    await q.query(`UPDATE playback_queue SET status = 'PLAYING', phase = 'PENDING', started_at = now() WHERE id = $1`, [next.id]);
    const m = await one<MessageRow>(q, `UPDATE messages SET status = 'PLAYING', updated_at = now() WHERE id = $1 RETURNING *`, [next.message_id]);
    if (actor) await recordModAction(q, { streamerId, actorId: actor.id, targetUserId: m!.sender_id, messageId: m!.id, action: 'PLAY' });
    outbox.push([Topic.channel(streamerId), Topic.user(m!.sender_id)], 'message.playing', { messageId: m!.id, streamerId });
    outbox.push([Topic.channel(streamerId), Topic.publicChannel(streamerId)], 'queue.updated', { streamerId });
    if (m!.sound_id) outbox.push(Topic.channel(streamerId), 'sound.played', { soundId: m!.sound_id, messageId: m!.id });
    return next;
  });
  outbox.flush(ctx.bus);
  if (!started) return null;
  // Usually already generated by warm-up; otherwise generated now (bounded by the TTS timeout).
  // A failure is recorded on the item and the viewer's audio plays without an announcement.
  await prepareItem(ctx, started.id);
  const payload = await overlayPayload(ctx, started.message_id, started.id);
  ctx.bus.publish(Topic.overlay(streamerId), 'overlay.play', payload);
  return payload;
}

export type FinishOutcome = 'PLAYED' | 'SKIPPED' | 'FAILED';

async function finishInTx(q: Db, outbox: Outbox, streamerId: string, itemId: string, outcome: FinishOutcome, actor: SessionUser | null) {
  const phase = outcome === 'PLAYED' ? 'COMPLETED' : outcome;
  const item = await one<{ message_id: string }>(
    q,
    `UPDATE playback_queue
        SET status = $2, phase = $4, finished_at = now(),
            announcement_status = CASE WHEN announcement_status IN ('READY','PENDING') THEN 'SKIPPED' ELSE announcement_status END
      WHERE id = $1 AND streamer_id = $3 AND status = 'PLAYING' RETURNING message_id`,
    [itemId, outcome === 'FAILED' ? 'SKIPPED' : outcome, streamerId, phase],
  );
  if (!item) return null;
  if (outcome === 'FAILED') {
    // The viewer's audio could not be played on stream: cancel and refund rather than claim it aired.
    const failed = await one<MessageRow>(q, `UPDATE messages SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`, [item.message_id]);
    await refundMessage(q, outbox, failed!, 'the audio could not be played on stream');
    await notify(q, outbox, failed!.sender_id, 'refund', 'Your message could not be played', 'The audio failed to load on stream, so your points were refunded.', { messageId: failed!.id, streamerId });
    outbox.push([Topic.channel(streamerId), Topic.user(failed!.sender_id)], 'message.updated', { messageId: failed!.id, status: 'CANCELLED', playbackFailed: true });
    outbox.push([Topic.channel(streamerId), Topic.user(failed!.sender_id)], 'message.skipped', { messageId: failed!.id, streamerId, itemId, reason: 'playback_failed' });
    outbox.push([Topic.channel(streamerId), Topic.publicChannel(streamerId)], 'queue.updated', { streamerId });
    outbox.push(Topic.overlay(streamerId), 'overlay.stop', { itemId });
    return failed;
  }
  const m = await one<MessageRow>(q, `UPDATE messages SET status = 'PLAYED', played_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [item.message_id]);
  if (actor && outcome === 'SKIPPED') await recordModAction(q, { streamerId, actorId: actor.id, targetUserId: m!.sender_id, messageId: m!.id, action: 'SKIP' });
  if (m!.type !== 'SOUND') {
    await notify(q, outbox, m!.sender_id, 'message.played', 'Your message played on stream', m!.text_content.slice(0, 80), { messageId: m!.id, streamerId });
  }
  outbox.push([Topic.channel(streamerId), Topic.user(m!.sender_id)], 'message.played', { messageId: m!.id, streamerId, outcome });
  outbox.push([Topic.channel(streamerId), Topic.user(m!.sender_id)], outcome === 'PLAYED' ? 'message.completed' : 'message.skipped', { messageId: m!.id, streamerId, itemId });
  outbox.push([Topic.channel(streamerId), Topic.publicChannel(streamerId)], 'queue.updated', { streamerId });
  if (outcome === 'SKIPPED') outbox.push(Topic.overlay(streamerId), 'overlay.stop', { itemId });
  return m;
}

/** Marks the playing item as finished (called by the overlay or the streamer). */
export async function finishPlaying(ctx: AppContext, streamerId: string, itemId: string, outcome: FinishOutcome, actor: SessionUser | null) {
  const outbox = new Outbox();
  const m = await ctx.db.tx(async (q) => {
    await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [streamerId]);
    return finishInTx(q, outbox, streamerId, itemId, outcome, actor);
  });
  outbox.flush(ctx.bus);
  if (m) {
    const s = await getSettings(ctx.db, streamerId);
    void tryAdvance(ctx, streamerId, s.playback_gap_ms);
  }
  return !!m;
}

/** Skip: stops the playing item, or removes a queued item (refunding the sender). */
export async function skipItem(ctx: AppContext, actor: SessionUser, streamerId: string, itemId: string) {
  const item = await one<{ status: string; message_id: string }>(ctx.db, 'SELECT status, message_id FROM playback_queue WHERE id = $1 AND streamer_id = $2', [itemId, streamerId]);
  if (!item) throw Errors.notFound('Queue item');
  if (item.status === 'PLAYING') return finishPlaying(ctx, streamerId, itemId, 'SKIPPED', actor);
  if (item.status !== 'QUEUED') throw Errors.conflict('Item is no longer in the queue');
  const outbox = new Outbox();
  await ctx.db.tx(async (q) => {
    await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [streamerId]);
    const r = await q.query(
      `UPDATE playback_queue SET status = 'SKIPPED', phase = 'SKIPPED', finished_at = now(),
              announcement_status = CASE WHEN announcement_status = 'NONE' THEN 'NONE' ELSE 'SKIPPED' END
        WHERE id = $1 AND status = 'QUEUED'`,
      [itemId],
    );
    if (!r.rowCount) throw Errors.conflict('Item is no longer in the queue');
    const m = await one<MessageRow>(q, `UPDATE messages SET status = 'CANCELLED', updated_at = now(), moderated_by = $2, moderated_at = now() WHERE id = $1 RETURNING *`, [
      item.message_id,
      actor.id,
    ]);
    await refundMessage(q, outbox, m!, 'removed from queue by the streamer');
    outbox.push([Topic.channel(streamerId), Topic.user(m!.sender_id)], 'message.skipped', { messageId: m!.id, streamerId, itemId, reason: 'removed' });
    await recordModAction(q, { streamerId, actorId: actor.id, targetUserId: m!.sender_id, messageId: m!.id, action: 'SKIP' });
    outbox.push([Topic.channel(streamerId), Topic.user(m!.sender_id)], 'message.updated', { messageId: m!.id, status: 'CANCELLED' });
    outbox.push([Topic.channel(streamerId), Topic.publicChannel(streamerId)], 'queue.updated', { streamerId });
  });
  outbox.flush(ctx.bus);
  return true;
}

export async function setPaused(ctx: AppContext, actor: SessionUser, streamerId: string, paused: boolean) {
  await ctx.db.query('UPDATE streamers SET queue_paused = $2, updated_at = now() WHERE id = $1', [streamerId, paused]);
  await audit(ctx.db, { actorUserId: actor.id, streamerId, action: paused ? 'queue.paused' : 'queue.resumed', entityType: 'streamer', entityId: streamerId });
  ctx.bus.publish(Topic.overlay(streamerId), 'overlay.settings', { paused });
  ctx.bus.publish(Topic.channel(streamerId), 'queue.updated', { streamerId, paused });
  if (!paused) await tryAdvance(ctx, streamerId);
}

/** Applies an explicit order to the queued items (drag-and-drop / move buttons). */
export async function reorderQueue(ctx: AppContext, actor: SessionUser, streamerId: string, orderedItemIds: string[]) {
  await ctx.db.tx(async (q) => {
    await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [streamerId]);
    const current = await q.query<{ id: string }>(`SELECT id FROM playback_queue WHERE streamer_id = $1 AND status = 'QUEUED'`, [streamerId]);
    const ids = new Set(current.rows.map((r) => r.id));
    if (orderedItemIds.length !== ids.size || !orderedItemIds.every((id) => ids.has(id)) || new Set(orderedItemIds).size !== ids.size) {
      throw Errors.conflict('The queue changed — refresh and try again', 'QUEUE_CHANGED');
    }
    // Explicit manual order pins every item; the priority engine resumes after "Reset to automatic".
    for (let i = 0; i < orderedItemIds.length; i++) {
      await q.query('UPDATE playback_queue SET pinned_rank = $2 WHERE id = $1', [orderedItemIds[i], i + 1]);
    }
    await audit(q, { actorUserId: actor.id, streamerId, action: 'queue.reordered', entityType: 'playback_queue', metadata: { count: orderedItemIds.length } });
  });
  ctx.bus.publish(Topic.channel(streamerId), 'queue.updated', { streamerId });
}

/** Clears manual pins so the priority engine decides the order again. */
export async function resetQueueOrder(ctx: AppContext, actor: SessionUser, streamerId: string) {
  const r = await ctx.db.query(`UPDATE playback_queue SET pinned_rank = NULL WHERE streamer_id = $1 AND status = 'QUEUED' AND pinned_rank IS NOT NULL`, [streamerId]);
  await audit(ctx.db, { actorUserId: actor.id, streamerId, action: 'queue.order_reset', entityType: 'playback_queue', metadata: { count: r.rowCount } });
  ctx.bus.publish(Topic.channel(streamerId), 'queue.updated', { streamerId });
  return r.rowCount;
}

/**
 * Housekeeping: expires stale pending messages (with refunds) and recovers
 * items stuck in PLAYING (e.g. the overlay was closed mid-playback).
 */
export async function sweep(ctx: AppContext) {
  const outbox = new Outbox();
  const stale = await ctx.db.query<MessageRow>(
    `SELECT m.* FROM messages m JOIN streamer_settings ss ON ss.streamer_id = m.streamer_id
      WHERE m.status IN ('PENDING','APPROVED') AND m.deleted_at IS NULL
        AND m.created_at < now() - make_interval(mins => ss.message_expiry_minutes)
      LIMIT 200`,
  );
  for (const m of stale.rows) {
    await ctx.db.tx(async (q) => {
      const r = await q.query(`UPDATE messages SET status = 'EXPIRED', updated_at = now() WHERE id = $1 AND status IN ('PENDING','APPROVED')`, [m.id]);
      if (!r.rowCount) return;
      await refundMessage(q, outbox, m, 'message expired before it was reviewed');
      await notify(q, outbox, m.sender_id, 'message.expired', 'Your message expired', 'It was not reviewed in time. Your points were refunded.', { messageId: m.id });
      outbox.push(Topic.channel(m.streamer_id), 'message.updated', { messageId: m.id, status: 'EXPIRED' });
    });
  }
  const stuck = await ctx.db.query<{ id: string; streamer_id: string }>(
    `SELECT q.id, q.streamer_id FROM playback_queue q
       JOIN messages m ON m.id = q.message_id
       LEFT JOIN audio_files a ON a.id = m.audio_file_id
       LEFT JOIN sounds so ON so.id = m.sound_id
       LEFT JOIN audio_files ann ON ann.id = q.announcement_audio_file_id
      WHERE q.status = 'PLAYING'
        AND q.started_at < now() - make_interval(secs => ((COALESCE(a.duration_ms, so.duration_ms, 30000) + COALESCE(ann.duration_ms, 0)) / 1000.0 + 60)::int)`,
  );
  outbox.flush(ctx.bus);
  for (const s of stuck.rows) await finishPlaying(ctx, s.streamer_id, s.id, 'PLAYED', null);
  return { expired: stale.rows.length, recovered: stuck.rows.length };
}
