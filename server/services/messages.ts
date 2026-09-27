import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { isUniqueViolation, one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { cleanText, findBlockedWord } from '../lib/text.js';
import { Outbox, Topic } from '../events/bus.js';
import { applyPoints } from './points.js';
import { notify } from './notifications.js';
import { audit } from './audit.js';
import { activeRestriction, recordModAction } from './moderation.js';
import { getSettings, requireChannel } from './streamers.js';
import { enqueue, playNext, refundMessage, tryAdvance } from './queue.js';
import { getPriorityConfig, tierPrice, TIERS, type TierKey, type TierRow } from './priority.js';
import { getMessageView } from './messageView.js';
import type { MessageRow, MessageType, SessionUser, StreamerRow, StreamerSettings } from './types.js';
import type { AudioFileRow } from './audio.js';

export const createMessageSchema = z.object({
  streamerId: z.string().uuid(),
  type: z.enum(['TEXT', 'VOICE', 'MP3', 'SOUND']),
  text: z.string().max(1000).optional().default(''),
  audioFileId: z.string().uuid().optional(),
  soundId: z.string().uuid().optional(),
  /** Legacy flag: maps to the PRIORITY tier. Prefer `priorityTier`. */
  priority: z.boolean().optional().default(false),
  priorityTier: z.enum(TIERS).optional(),
  bonusPoints: z.number().int().min(0).max(1_000_000).optional().default(0),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

const TEXT_MAX = 300;

interface SoundRow {
  id: string;
  streamer_id: string;
  name: string;
  price_points: number;
  cooldown_seconds: number;
  daily_limit: number;
  is_active: boolean;
  deleted_at: Date | null;
}

export function basePriceFor(type: MessageType, settings: StreamerSettings, sound: Pick<SoundRow, 'price_points'> | null, freeText: boolean) {
  return type === 'TEXT' ? (freeText ? 0 : settings.price_text) : type === 'VOICE' ? settings.price_voice : type === 'MP3' ? settings.price_mp3 : sound!.price_points;
}

/**
 * Quote = what the backend will charge. The client never supplies a price.
 * With the priority queue on, `tier` decides the total (tier minimum, never
 * below the normal price) and the difference is the priority premium; with it
 * off, the legacy flat "priority" surcharge applies.
 */
export function priceFor(type: MessageType, settings: StreamerSettings, sound: Pick<SoundRow, 'price_points'> | null, opts: { tier: TierRow | null; legacyPriority: boolean }, bonus: number, freeText: boolean) {
  const base = basePriceFor(type, settings, sound, freeText);
  const priority = opts.tier ? tierPrice(base, opts.tier) - base : opts.legacyPriority ? settings.price_priority : 0;
  return { base, priority, bonus, total: base + priority + bonus, tier: (opts.tier?.tier ?? 'NORMAL') as TierKey };
}

/** Resolves the tier a viewer asked for against the channel's (server-side) configuration. */
export function resolveTier(prio: Awaited<ReturnType<typeof getPriorityConfig>>, input: { priorityTier?: TierKey; priority?: boolean }) {
  if (!prio.settings.enabled) return null;
  const key = input.priorityTier ?? (input.priority ? 'PRIORITY' : prio.settings.default_tier);
  const tier = prio.tierMap.get(key);
  if (!tier || !tier.is_active) throw Errors.validation('That priority tier is not available on this channel', { tier: key });
  return tier;
}

async function assertCanSend(q: Db, user: SessionUser, streamer: StreamerRow) {
  if (user.status !== 'ACTIVE') throw Errors.suspended();
  if (streamer.status !== 'ACTIVE') throw Errors.featureDisabled('This channel is currently unavailable');
  if (streamer.user_id === user.id) throw Errors.badRequest('Use the soundboard or queue controls on your own channel');
  const r = await activeRestriction(q, streamer.id, user.id);
  if (r) {
    const until = r.expires_at ? ` until ${r.expires_at.toISOString()}` : '';
    throw Errors.banned(r.kind === 'BAN' ? `You are banned from this channel${until}` : `You are muted on this channel${until}`, {
      kind: r.kind,
      expiresAt: r.expires_at,
      scope: r.scope,
    });
  }
}

/**
 * Creates a paid message. All rules are enforced here, server-side, inside one
 * transaction holding a per-(user, channel) advisory lock so cooldowns, daily
 * limits and point spends cannot be raced by parallel requests.
 */
export async function createMessage(ctx: AppContext, user: SessionUser, input: CreateMessageInput, idempotencyKey: string | null) {
  if (idempotencyKey && !/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) throw Errors.badRequest('Invalid Idempotency-Key');
  if (idempotencyKey) {
    const prior = await one<{ id: string }>(ctx.db, 'SELECT id FROM messages WHERE sender_id = $1 AND idempotency_key = $2', [user.id, idempotencyKey]);
    if (prior) return { message: await getMessageView(ctx.db, prior.id), replayed: true };
  }

  const outbox = new Outbox();
  let queued = false;
  let result: { id: string; blocked: boolean };
  try {
    result = await ctx.db.tx(async (q) => {
      const streamer = await one<StreamerRow>(q, 'SELECT * FROM streamers WHERE id = $1 AND deleted_at IS NULL', [input.streamerId]);
      if (!streamer) throw Errors.notFound('Streamer');
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`msg:${user.id}:${streamer.id}`]);
      await assertCanSend(q, user, streamer);
      const settings = await getSettings(q, streamer.id);

      // Feature toggles
      const enabled = { TEXT: settings.text_enabled, VOICE: settings.voice_enabled, MP3: settings.mp3_enabled, SOUND: settings.sounds_enabled }[input.type];
      if (!enabled) throw Errors.featureDisabled(`${input.type === 'MP3' ? 'Audio clip' : input.type.toLowerCase()} messages are turned off on this channel`);

      const text = cleanText(input.text ?? '', TEXT_MAX);
      if (input.type === 'TEXT' && !text) throw Errors.validation('Message text is required');
      if ((input.text ?? '').trim().length > TEXT_MAX) throw Errors.validation(`Messages are limited to ${TEXT_MAX} characters`);

      // Audio ownership + limits (re-validated against THIS channel's limits)
      let audio: AudioFileRow | null = null;
      if (input.type === 'VOICE' || input.type === 'MP3') {
        if (!input.audioFileId) throw Errors.validation('Audio is required');
        audio = await one<AudioFileRow>(q, 'SELECT * FROM audio_files WHERE id = $1 FOR UPDATE', [input.audioFileId]);
        if (!audio || audio.deleted_at || audio.owner_id !== user.id) throw Errors.notFound('Audio file');
        if (audio.purpose !== 'MESSAGE') throw Errors.validation('This audio file cannot be used for messages');
        if (audio.attached_at) throw Errors.conflict('This recording was already sent', 'AUDIO_ALREADY_USED');
        if (audio.streamer_id && audio.streamer_id !== streamer.id) throw Errors.validation('This recording was uploaded for a different channel');
        if (input.type === 'VOICE' && audio.container !== 'wav') throw Errors.validation('Voice messages must be recorded in the browser');
        if (audio.duration_ms > settings.max_audio_seconds * 1000 + 250) throw Errors.audioTooLong(audio.duration_ms, settings.max_audio_seconds);
        if (audio.size_bytes > settings.max_file_bytes) throw Errors.fileTooLarge(settings.max_file_bytes);
      }

      // Sound effects: channel-owned, active, global per-sound cooldown and daily cap
      let sound: SoundRow | null = null;
      if (input.type === 'SOUND') {
        if (!input.soundId) throw Errors.validation('Choose a sound');
        sound = await one<SoundRow>(q, 'SELECT * FROM sounds WHERE id = $1 FOR UPDATE', [input.soundId]);
        if (!sound || sound.deleted_at || sound.streamer_id !== streamer.id) throw Errors.notFound('Sound');
        if (!sound.is_active) throw Errors.featureDisabled('This sound is currently disabled');
        if (sound.cooldown_seconds > 0) {
          const last = await one<{ age: number }>(
            q,
            `SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::int AS age FROM sound_usage WHERE sound_id = $1`,
            [sound.id],
          );
          if (last?.age != null && last.age < sound.cooldown_seconds) throw Errors.cooldown(sound.cooldown_seconds - last.age, `"${sound.name}"`);
        }
        if (sound.daily_limit > 0) {
          const used = await one<{ n: number }>(q, `SELECT COUNT(*)::int AS n FROM sound_usage WHERE sound_id = $1 AND created_at >= date_trunc('day', now())`, [sound.id]);
          if (used!.n >= sound.daily_limit) throw Errors.limitReached(`"${sound.name}" reached its daily limit`, { limit: sound.daily_limit });
        }
      }

      // Per-user cooldown and daily cap on this channel
      const stats = await one<{ last_age: number | null; today: number; free_used: number }>(
        q,
        `SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::int AS last_age,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND type = 'TEXT' AND points_spent = 0 AND donation_id IS NULL)::int AS free_used
           FROM messages WHERE sender_id = $1 AND streamer_id = $2 AND status <> 'CANCELLED' AND donation_id IS NULL`,
        [user.id, streamer.id],
      );
      if (settings.cooldown_seconds > 0 && stats!.last_age != null && stats!.last_age < settings.cooldown_seconds) {
        throw Errors.cooldown(settings.cooldown_seconds - stats!.last_age);
      }
      if (settings.daily_message_limit > 0 && stats!.today >= settings.daily_message_limit) {
        throw Errors.limitReached(`You reached today's limit of ${settings.daily_message_limit} messages on this channel`, { limit: settings.daily_message_limit });
      }
      const inQueue = await one<{ n: number }>(q, `SELECT COUNT(*)::int AS n FROM messages WHERE streamer_id = $1 AND status IN ('PENDING','APPROVED','QUEUED')`, [streamer.id]);
      if (inQueue!.n >= settings.queue_limit) throw Errors.limitReached('The queue is full right now — try again in a few minutes', { queueLimit: settings.queue_limit });

      // Priority tier (server-side config; the client only names a tier) + its limits
      const prio = await getPriorityConfig(q, streamer.id);
      const tier = resolveTier(prio, input);
      if (prio.settings.enabled) {
        const mine = await one<{ n: number }>(
          q,
          `SELECT COUNT(*)::int AS n FROM messages WHERE sender_id = $1 AND streamer_id = $2 AND status IN ('PENDING','APPROVED','QUEUED','PLAYING')`,
          [user.id, streamer.id],
        );
        if (mine!.n >= prio.settings.max_messages_per_viewer) {
          throw Errors.limitReached(`You already have ${mine!.n} message(s) waiting on this channel — wait for one to play first`, { limit: prio.settings.max_messages_per_viewer });
        }
      }
      if (tier && tier.tier !== 'NORMAL' && (tier.cooldown_seconds > 0 || tier.daily_limit > 0)) {
        const use = await one<{ last_age: number | null; today: number }>(
          q,
          `SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::int AS last_age,
                  COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today
             FROM messages WHERE sender_id = $1 AND streamer_id = $2 AND priority_tier = $3 AND status NOT IN ('CANCELLED','REJECTED')`,
          [user.id, streamer.id, tier.tier],
        );
        if (tier.cooldown_seconds > 0 && use!.last_age != null && use!.last_age < tier.cooldown_seconds) throw Errors.cooldown(tier.cooldown_seconds - use!.last_age, `${tier.name} message`);
        if (tier.daily_limit > 0 && use!.today >= tier.daily_limit) throw Errors.limitReached(`You used today's ${tier.daily_limit} ${tier.name} message(s)`, { limit: tier.daily_limit });
      }

      // Price (server-computed)
      const isNormal = !tier || tier.tier === 'NORMAL';
      const freeText = input.type === 'TEXT' && isNormal && !input.priority && input.bonusPoints === 0 && stats!.free_used < settings.free_text_per_day;
      const price = priceFor(input.type, settings, sound, { tier, legacyPriority: input.priority }, input.bonusPoints, freeText);
      if (price.total > 0 || settings.min_points_per_message > 0) {
        if (price.total < settings.min_points_per_message) {
          throw Errors.validation(`This channel requires at least ${settings.min_points_per_message} points per message`, { minPoints: settings.min_points_per_message });
        }
      }
      if (price.total > settings.max_points_per_message) {
        throw Errors.validation(`This channel allows at most ${settings.max_points_per_message} points per message`, { maxPoints: settings.max_points_per_message });
      }

      // Blocked words: auto-reject (no charge) or flag for manual review
      const blocked = findBlockedWord(text, settings.blocked_words);
      if (blocked && settings.auto_reject_blocked_words) {
        const rejected = await insertMessage(q, {
          streamer,
          user,
          input,
          text,
          audio,
          points: 0,
          priorityPoints: 0,
          tier: 'NORMAL',
          isPriority: false,
          status: 'REJECTED',
          flagged: true,
          flagReason: 'Blocked word',
          rejection: 'Contains a blocked word',
          idempotencyKey,
        });
        await recordModAction(q, { streamerId: streamer.id, actorId: user.id, targetUserId: user.id, messageId: rejected.id, action: 'AUTO_REJECT', reason: 'Blocked word' });
        outbox.push(Topic.channel(streamer.id), 'message.rejected', { messageId: rejected.id, auto: true });
        // Commit the rejected record (visible in moderation + history), then report the error.
        return { id: rejected.id, blocked: true };
      }

      const autoApprove = (input.type === 'SOUND' || settings.approval_mode === 'AUTO') && !blocked;
      const msg = await insertMessage(q, {
        streamer,
        user,
        input,
        text,
        audio,
        points: price.total,
        priorityPoints: tier ? price.priority : 0,
        tier: price.tier,
        isPriority: tier ? price.tier !== 'NORMAL' : input.priority,
        status: autoApprove ? 'APPROVED' : 'PENDING',
        flagged: !!blocked,
        flagReason: blocked ? 'Blocked word (manual review)' : null,
        rejection: null,
        idempotencyKey,
      });

      // Two ledger entries: the message itself, and the priority premium (if any).
      // Both run in this transaction under the account row lock — no double spending.
      const baseSpend = price.total - (tier ? price.priority : 0);
      const premium = tier ? price.priority : 0;
      if (premium > 0) {
        const bal = await one<{ balance: number }>(q, 'SELECT COALESCE((SELECT balance FROM points_accounts WHERE user_id = $1), 0) AS balance', [user.id]);
        if (bal!.balance < price.total) throw Errors.insufficientPoints(price.total, bal!.balance);
      }
      if (baseSpend > 0) {
        await applyPoints(
          q,
          {
            userId: user.id,
            streamerId: streamer.id,
            type: 'POINTS_SPENT',
            amount: -baseSpend,
            description: describeSpend(input.type, streamer.display_name, sound?.name),
            referenceType: 'message',
            referenceId: msg.id,
            idempotencyKey: `spend:message:${msg.id}`,
          },
          outbox,
        );
      }
      if (premium > 0) {
        await applyPoints(
          q,
          {
            userId: user.id,
            streamerId: streamer.id,
            type: 'POINTS_SPENT_PRIORITY',
            amount: -premium,
            description: `${tier!.name} playback priority on ${streamer.display_name}`,
            referenceType: 'message',
            referenceId: msg.id,
            idempotencyKey: `spend:priority:${msg.id}`,
            priorityTier: tier!.tier,
          },
          outbox,
        );
      }
      if (audio) await q.query('UPDATE audio_files SET attached_at = now(), streamer_id = $2 WHERE id = $1', [audio.id, streamer.id]);
      if (sound) await q.query('INSERT INTO sound_usage (sound_id, streamer_id, user_id, message_id, points_spent) VALUES ($1,$2,$3,$4,$5)', [sound.id, streamer.id, user.id, msg.id, price.total]);

      outbox.push([Topic.channel(streamer.id), Topic.user(user.id)], 'message.created', { messageId: msg.id, streamerId: streamer.id, status: msg.status, type: msg.type });
      if (autoApprove && settings.auto_queue_approved) {
        await enqueue(q, outbox, msg);
        queued = true;
      }
      return { id: msg.id, blocked: false };
    });
  } catch (err) {
    if (idempotencyKey && isUniqueViolation(err, 'messages_idem_uq')) {
      const prior = await one<{ id: string }>(ctx.db, 'SELECT id FROM messages WHERE sender_id = $1 AND idempotency_key = $2', [user.id, idempotencyKey]);
      if (prior) return { message: await getMessageView(ctx.db, prior.id), replayed: true };
    }
    throw err;
  }
  outbox.flush(ctx.bus);
  if (result.blocked) throw new AppError(422, 'MESSAGE_BLOCKED', 'Your message contains a word this channel does not allow', { messageId: result.id });
  if (queued) await tryAdvance(ctx, input.streamerId);
  return { message: await getMessageView(ctx.db, result.id), replayed: false };
}

function describeSpend(type: MessageType, channel: string, soundName?: string) {
  if (type === 'SOUND') return `Sound "${soundName}" on ${channel}`;
  return `${type === 'TEXT' ? 'Text' : type === 'VOICE' ? 'Voice' : 'Audio clip'} message to ${channel}`;
}

async function insertMessage(
  q: Db,
  a: {
    streamer: StreamerRow;
    user: SessionUser;
    input: CreateMessageInput;
    text: string;
    audio: AudioFileRow | null;
    points: number;
    priorityPoints: number;
    tier: TierKey;
    isPriority: boolean;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    flagged: boolean;
    flagReason: string | null;
    rejection: string | null;
    idempotencyKey: string | null;
  },
): Promise<MessageRow> {
  const row = await one<MessageRow>(
    q,
    `INSERT INTO messages (streamer_id, sender_id, type, text_content, audio_file_id, sound_id, points_spent, bonus_points, is_priority, status,
                           flagged, flag_reason, rejection_reason, idempotency_key, priority_tier, priority_points)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      a.streamer.id,
      a.user.id,
      a.input.type,
      a.text,
      a.audio?.id ?? null,
      a.input.type === 'SOUND' ? a.input.soundId : null,
      a.points,
      a.status === 'REJECTED' ? 0 : a.input.bonusPoints,
      a.isPriority,
      a.status,
      a.flagged,
      a.flagReason,
      a.rejection,
      a.idempotencyKey,
      a.tier,
      a.priorityPoints,
    ],
  );
  return row!;
}

// ── Moderation actions on a single message ──────────────────────────────────

async function loadForModeration(q: Db, user: SessionUser, messageId: string, action: 'approve' | 'other') {
  const m = await one<MessageRow>(q, 'SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [messageId]);
  if (!m) throw Errors.notFound('Message');
  const access = await requireChannel(q, user, m.streamer_id, 'moderate');
  if (access === 'moderator' && action === 'approve') {
    const s = await getSettings(q, m.streamer_id);
    if (!s.moderators_can_approve) throw Errors.forbidden('Moderators cannot approve messages on this channel');
  }
  return m;
}

export async function approveMessage(ctx: AppContext, actor: SessionUser, messageId: string, ipHash: string | null) {
  const outbox = new Outbox();
  let queued = false;
  const m = await ctx.db.tx(async (q) => {
    const m = await loadForModeration(q, actor, messageId, 'approve');
    if (m.status !== 'PENDING') throw Errors.conflict(`Message is already ${m.status.toLowerCase()}`, 'INVALID_STATE');
    const updated = await one<MessageRow>(
      q,
      `UPDATE messages SET status = 'APPROVED', moderated_by = $2, moderated_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id, actor.id],
    );
    await recordModAction(q, { streamerId: m.streamer_id, actorId: actor.id, targetUserId: m.sender_id, messageId: m.id, action: 'APPROVE' });
    await audit(q, { actorUserId: actor.id, streamerId: m.streamer_id, action: 'message.approved', entityType: 'message', entityId: m.id, ipHash });
    await notify(q, outbox, m.sender_id, 'message.approved', 'Your message was approved', m.text_content.slice(0, 80), { messageId: m.id, streamerId: m.streamer_id });
    outbox.push([Topic.channel(m.streamer_id), Topic.user(m.sender_id)], 'message.approved', { messageId: m.id, streamerId: m.streamer_id });
    const s = await getSettings(q, m.streamer_id);
    if (s.auto_queue_approved) {
      await enqueue(q, outbox, updated!);
      queued = true;
    }
    return updated!;
  });
  outbox.flush(ctx.bus);
  if (queued) await tryAdvance(ctx, m.streamer_id);
  return getMessageView(ctx.db, m.id);
}

/** Queues an APPROVED message (when auto-queue is off). */
export async function queueMessage(ctx: AppContext, actor: SessionUser, messageId: string) {
  const outbox = new Outbox();
  const m = await ctx.db.tx(async (q) => {
    const m = await loadForModeration(q, actor, messageId, 'approve');
    if (m.status !== 'APPROVED') throw Errors.conflict('Only approved messages can be queued', 'INVALID_STATE');
    await enqueue(q, outbox, m);
    return m;
  });
  outbox.flush(ctx.bus);
  await tryAdvance(ctx, m.streamer_id);
  return getMessageView(ctx.db, m.id);
}

export async function rejectMessage(ctx: AppContext, actor: SessionUser, messageId: string, reason: string, ipHash: string | null) {
  const outbox = new Outbox();
  const m = await ctx.db.tx(async (q) => {
    const m = await loadForModeration(q, actor, messageId, 'other');
    if (!['PENDING', 'APPROVED', 'QUEUED'].includes(m.status)) throw Errors.conflict(`Message is already ${m.status.toLowerCase()}`, 'INVALID_STATE');
    await rejectInTx(q, outbox, m, actor, cleanText(reason || 'Rejected by moderator', 200));
    await audit(q, { actorUserId: actor.id, streamerId: m.streamer_id, action: 'message.rejected', entityType: 'message', entityId: m.id, metadata: { reason }, ipHash });
    return m;
  });
  outbox.flush(ctx.bus);
  return getMessageView(ctx.db, m.id);
}

async function rejectInTx(q: Db, outbox: Outbox, m: MessageRow, actor: SessionUser, reason: string) {
  await q.query(
    `UPDATE messages SET status = 'REJECTED', rejection_reason = $3, moderated_by = $2, moderated_at = now(), updated_at = now() WHERE id = $1`,
    [m.id, actor.id, reason],
  );
  await q.query(`UPDATE playback_queue SET status = 'REMOVED', phase = 'SKIPPED', finished_at = now() WHERE message_id = $1 AND status = 'QUEUED'`, [m.id]);
  const s = await getSettings(q, m.streamer_id);
  const prio = await getPriorityConfig(q, m.streamer_id);
  // Normal price and priority premium have independent refund switches.
  const refundBase = s.refund_on_reject;
  const refundPremium = prio.settings.refund_priority_on_reject;
  const premium = Math.min(m.priority_points, m.points_spent);
  const refundedAmount = (refundBase ? m.points_spent - premium : 0) + (refundPremium ? premium : 0);
  const refunded = refundedAmount > 0 ? await refundMessage(q, outbox, m, 'message rejected', { base: refundBase, priority: refundPremium }) : false;
  await recordModAction(q, { streamerId: m.streamer_id, actorId: actor.id, targetUserId: m.sender_id, messageId: m.id, action: 'REJECT', reason });
  await notify(
    q,
    outbox,
    m.sender_id,
    'message.rejected',
    'Your message was rejected',
    refunded ? `${reason}. ${refundedAmount} points were refunded.` : reason,
    { messageId: m.id, streamerId: m.streamer_id, refunded },
  );
  outbox.push([Topic.channel(m.streamer_id), Topic.user(m.sender_id)], 'message.rejected', { messageId: m.id, streamerId: m.streamer_id });
  outbox.push([Topic.channel(m.streamer_id), Topic.publicChannel(m.streamer_id)], 'queue.updated', { streamerId: m.streamer_id });
}

/** Used when a user is banned/muted: rejects everything they have waiting on the channel. */
export async function rejectPendingFromUser(q: Db, outbox: Outbox, streamerId: string, userId: string, actor: SessionUser) {
  const rows = await q.query<MessageRow>(
    `SELECT * FROM messages WHERE streamer_id = $1 AND sender_id = $2 AND status IN ('PENDING','APPROVED','QUEUED') AND deleted_at IS NULL FOR UPDATE`,
    [streamerId, userId],
  );
  for (const m of rows.rows) await rejectInTx(q, outbox, m, actor, 'Sender was restricted on this channel');
  return rows.rows.length;
}

/** Soft-deletes a message and its audio (content removal). Refunds unplayed messages per channel policy. */
export async function deleteMessage(ctx: AppContext, actor: SessionUser, messageId: string, ipHash: string | null) {
  const outbox = new Outbox();
  let audioKey: string | null = null;
  const m = await ctx.db.tx(async (q) => {
    const m = await one<MessageRow>(q, 'SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [messageId]);
    if (!m) throw Errors.notFound('Message');
    if (actor.role !== 'ADMIN') await requireChannel(q, actor, m.streamer_id, 'moderate');
    if (m.status === 'PLAYING') throw Errors.conflict('Skip the message before deleting it', 'INVALID_STATE');
    if (['PENDING', 'APPROVED', 'QUEUED'].includes(m.status)) await rejectInTx(q, outbox, m, actor, 'Removed by moderator');
    await q.query('UPDATE messages SET deleted_at = now(), text_content = $2, updated_at = now() WHERE id = $1', [m.id, '']);
    if (m.audio_file_id) {
      const a = await one<{ storage_key: string }>(q, 'UPDATE audio_files SET deleted_at = now() WHERE id = $1 RETURNING storage_key', [m.audio_file_id]);
      audioKey = a?.storage_key ?? null;
    }
    await recordModAction(q, { streamerId: m.streamer_id, actorId: actor.id, targetUserId: m.sender_id, messageId: m.id, action: 'DELETE' });
    await audit(q, { actorUserId: actor.id, streamerId: m.streamer_id, action: 'message.deleted', entityType: 'message', entityId: m.id, ipHash });
    outbox.push(Topic.channel(m.streamer_id), 'message.updated', { messageId: m.id, deleted: true });
    return m;
  });
  outbox.flush(ctx.bus);
  if (audioKey) await ctx.storage.delete(audioKey).catch((err) => ctx.log.warn({ err }, 'audio delete failed'));
  return { id: m.id, deleted: true };
}

export async function setFlag(ctx: AppContext, actor: SessionUser, messageId: string, flagged: boolean, reason: string) {
  const m = await one<MessageRow>(ctx.db, 'SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL', [messageId]);
  if (!m) throw Errors.notFound('Message');
  await requireChannel(ctx.db, actor, m.streamer_id, 'moderate');
  await ctx.db.query('UPDATE messages SET flagged = $2, flag_reason = $3, updated_at = now() WHERE id = $1', [m.id, flagged, flagged ? cleanText(reason, 200) || 'Flagged' : null]);
  await recordModAction(ctx.db, { streamerId: m.streamer_id, actorId: actor.id, targetUserId: m.sender_id, messageId: m.id, action: flagged ? 'FLAG' : 'UNFLAG', reason });
  ctx.bus.publish(Topic.channel(m.streamer_id), 'message.updated', { messageId: m.id, flagged });
  return getMessageView(ctx.db, m.id);
}

/** Sender cancels their own message while it is still waiting for review. */
export async function cancelOwnMessage(ctx: AppContext, user: SessionUser, messageId: string) {
  const outbox = new Outbox();
  await ctx.db.tx(async (q) => {
    const m = await one<MessageRow>(q, 'SELECT * FROM messages WHERE id = $1 AND sender_id = $2 FOR UPDATE', [messageId, user.id]);
    if (!m) throw Errors.notFound('Message');
    if (m.status !== 'PENDING') throw Errors.conflict('Only messages waiting for review can be cancelled', 'INVALID_STATE');
    await q.query(`UPDATE messages SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [m.id]);
    await refundMessage(q, outbox, m, 'you cancelled the message');
    outbox.push([Topic.channel(m.streamer_id), Topic.user(user.id)], 'message.updated', { messageId: m.id, status: 'CANCELLED' });
  });
  outbox.flush(ctx.bus);
  return getMessageView(ctx.db, messageId);
}

/** "Play now": approves if needed, moves to the front and interrupts whatever is playing. */
export async function playNow(ctx: AppContext, actor: SessionUser, messageId: string) {
  const outbox = new Outbox();
  const m = await ctx.db.tx(async (q) => {
    const m = await loadForModeration(q, actor, messageId, 'approve');
    await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [m.streamer_id]);
    if (m.status === 'PENDING') {
      await q.query(`UPDATE messages SET status = 'APPROVED', moderated_by = $2, moderated_at = now() WHERE id = $1`, [m.id, actor.id]);
      await notify(q, outbox, m.sender_id, 'message.approved', 'Your message was approved', '', { messageId: m.id });
      outbox.push([Topic.channel(m.streamer_id), Topic.user(m.sender_id)], 'message.approved', { messageId: m.id });
    }
    if (m.status === 'PENDING' || m.status === 'APPROVED') await enqueue(q, outbox, { ...m, is_priority: true });
    else if (m.status !== 'QUEUED') throw Errors.conflict(`Message is already ${m.status.toLowerCase()}`, 'INVALID_STATE');
    await q.query(
      `UPDATE playback_queue SET pinned_rank = (SELECT COALESCE(MIN(pinned_rank), 0) - 1 FROM playback_queue WHERE streamer_id = $2 AND status = 'QUEUED') WHERE message_id = $1`,
      [m.id, m.streamer_id],
    );
    return m;
  });
  outbox.flush(ctx.bus);
  return playNext(ctx, m.streamer_id, actor, { force: true });
}
