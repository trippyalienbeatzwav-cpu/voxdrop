import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/client.js';
import { cleanText } from '../lib/text.js';
import { getSettings, getStreamerBySlug, publicStreamer } from '../services/streamers.js';
import { listCategories, listSounds } from '../services/sounds.js';
import { activeRestriction } from '../services/moderation.js';
import { priceFor, resolveTier } from '../services/messages.js';
import { getPriorityConfig, TIERS, type TierKey } from '../services/priority.js';
import { computeQueue } from '../services/queue.js';
import { getBalance } from '../services/points.js';
import type { StreamerRow } from '../services/types.js';
import { parse, requireUser } from '../http.js';

export const publicRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/config', async () => ({
      kickMode: ctx.config.KICK_MODE,
      paymentProvider: ctx.config.PAYMENT_PROVIDER,
      storageProvider: ctx.config.STORAGE_PROVIDER,
      malwareScanning: ctx.scanner.name !== 'none',
      currency: ctx.config.PAYMENT_CURRENCY,
      dailyBonusPoints: ctx.config.DAILY_BONUS_POINTS,
      devMocks: ctx.config.usesMocks,
      discordUrl: ctx.config.DISCORD_INVITE_URL ?? null,
    }));

    app.get('/api/streamers', async (req) => {
      const q = parse(
        z.object({
          q: z.string().max(60).optional(),
          live: z.enum(['true', 'false']).optional(),
          sort: z.enum(['popular', 'live', 'new', 'name']).optional().default('popular'),
          limit: z.coerce.number().int().min(1).max(60).default(24),
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        }),
        req.query,
      );
      const params: unknown[] = [];
      let where = `s.deleted_at IS NULL AND s.status = 'ACTIVE'`;
      if (q.q) {
        params.push(`%${cleanText(q.q, 60).replace(/[%_\\]/g, (m) => '\\' + m)}%`);
        where += ` AND (s.slug ILIKE $${params.length} OR s.display_name ILIKE $${params.length})`;
      }
      if (q.live === 'true') where += ' AND s.is_live';
      const order = {
        popular: 'activity DESC, s.display_name ASC',
        live: 's.is_live DESC, activity DESC',
        new: 's.created_at DESC',
        name: 's.display_name ASC',
      }[q.sort];
      params.push(q.limit + 1, q.offset);
      const rows = await many<StreamerRow & { activity: number; sound_count: number; voice_enabled: boolean; price_voice: number; price_text: number }>(
        ctx.db,
        `SELECT s.*, ss.voice_enabled, ss.price_voice, ss.price_text,
                (SELECT COUNT(*)::int FROM messages m WHERE m.streamer_id = s.id AND m.created_at > now() - interval '7 days') AS activity,
                (SELECT COUNT(*)::int FROM sounds so WHERE so.streamer_id = s.id AND so.deleted_at IS NULL AND so.is_active) AS sound_count
           FROM streamers s JOIN streamer_settings ss ON ss.streamer_id = s.id
          WHERE ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const hasMore = rows.length > q.limit;
      return {
        items: rows.slice(0, q.limit).map((r) => ({
          ...publicStreamer(r),
          activity7d: r.activity,
          soundCount: r.sound_count,
          voiceEnabled: r.voice_enabled,
          priceVoice: r.price_voice,
          priceText: r.price_text,
        })),
        nextOffset: hasMore ? q.offset + q.limit : null,
      };
    });

    app.get('/api/streamers/:slug', async (req) => {
      const { slug } = parse(z.object({ slug: z.string().min(1).max(60) }), req.params);
      const s = await getStreamerBySlug(ctx.db, slug);
      const settings = await getSettings(ctx.db, s.id);
      const stats = await one<{ queue: number; sounds: number; played: number }>(
        ctx.db,
        `SELECT (SELECT COUNT(*)::int FROM playback_queue WHERE streamer_id = $1 AND status = 'QUEUED') AS queue,
                (SELECT COUNT(*)::int FROM sounds WHERE streamer_id = $1 AND deleted_at IS NULL AND is_active) AS sounds,
                (SELECT COUNT(*)::int FROM messages WHERE streamer_id = $1 AND status = 'PLAYED') AS played`,
        [s.id],
      );
      let viewer = null;
      if (req.user) {
        const r = await activeRestriction(ctx.db, s.id, req.user.id);
        viewer = { isOwner: s.user_id === req.user.id, restriction: r && { kind: r.kind, expiresAt: r.expires_at, reason: r.reason } };
      }
      return { streamer: { ...publicStreamer(s, settings), status: s.status }, stats, viewer };
    });

    app.get('/api/streamers/:slug/sounds', async (req) => {
      const { slug } = parse(z.object({ slug: z.string().min(1).max(60) }), req.params);
      const q = parse(
        z.object({
          category: z.string().max(40).optional(),
          q: z.string().max(60).optional(),
          sort: z.enum(['popular', 'price_asc', 'price_desc', 'newest', 'name', 'custom']).optional(),
        }),
        req.query,
      );
      const s = await getStreamerBySlug(ctx.db, slug);
      return { items: await listSounds(ctx.db, { streamerId: s.id, ...q }) };
    });

    /**
     * Server-side price quote shown before the viewer confirms a spend — the
     * same `priceFor` function the purchase itself uses.
     */
    app.get('/api/streamers/:slug/quote', async (req) => {
      const user = requireUser(req);
      const { slug } = parse(z.object({ slug: z.string().min(1).max(60) }), req.params);
      const q = parse(
        z.object({
          type: z.enum(['TEXT', 'VOICE', 'MP3', 'SOUND']),
          priority: z.enum(['true', 'false']).optional(),
          priorityTier: z.enum(TIERS).optional(),
          bonus: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
          soundId: z.string().uuid().optional(),
        }),
        req.query,
      );
      const s = await getStreamerBySlug(ctx.db, slug);
      const prio = await getPriorityConfig(ctx.db, s.id);
      const tier = resolveTier(prio, { priorityTier: q.priorityTier, priority: q.priority === 'true' });
      const settings = await getSettings(ctx.db, s.id);
      const sound = q.soundId
        ? await one<{ id: string; streamer_id: string; name: string; price_points: number; cooldown_seconds: number; daily_limit: number; is_active: boolean; deleted_at: Date | null }>(
            ctx.db,
            'SELECT * FROM sounds WHERE id = $1 AND streamer_id = $2 AND deleted_at IS NULL',
            [q.soundId, s.id],
          )
        : null;
      if (q.type === 'SOUND' && !sound) return { error: { code: 'NOT_FOUND', message: 'Sound not found' } };
      const stats = await one<{ last_age: number | null; today: number; free_used: number }>(
        ctx.db,
        `SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::int AS last_age,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND type = 'TEXT' AND points_spent = 0 AND donation_id IS NULL)::int AS free_used
           FROM messages WHERE sender_id = $1 AND streamer_id = $2 AND status <> 'CANCELLED' AND donation_id IS NULL`,
        [user.id, s.id],
      );
      const priority = q.priority === 'true';
      const isNormal = !tier || tier.tier === 'NORMAL';
      const freeText = q.type === 'TEXT' && isNormal && !priority && q.bonus === 0 && stats!.free_used < settings.free_text_per_day;
      const price = priceFor(q.type, settings, sound, { tier, legacyPriority: priority }, q.bonus, freeText);
      const balance = await getBalance(ctx.db, user.id);
      const cooldownRemaining = settings.cooldown_seconds > 0 && stats!.last_age != null ? Math.max(0, settings.cooldown_seconds - stats!.last_age) : 0;
      return {
        price,
        balance,
        balanceAfter: balance - price.total,
        affordable: balance >= price.total,
        freeTextRemaining: Math.max(0, settings.free_text_per_day - stats!.free_used),
        cooldownRemaining,
        dailyRemaining: settings.daily_message_limit > 0 ? Math.max(0, settings.daily_message_limit - stats!.today) : null,
        minPerMessage: settings.min_points_per_message,
        maxPerMessage: settings.max_points_per_message,
      };
    });

    /**
     * Playback priority options for a message the viewer is about to send:
     * each tier's server-computed price, whether it is available right now
     * (tier cooldown / daily limit), and an estimated queue position + wait.
     * Estimates only — the queue keeps changing.
     */
    app.get('/api/streamers/:slug/priority', async (req) => {
      const user = requireUser(req);
      const { slug } = parse(z.object({ slug: z.string().min(1).max(60) }), req.params);
      const q = parse(
        z.object({ type: z.enum(['TEXT', 'VOICE', 'MP3', 'SOUND']).default('VOICE'), soundId: z.string().uuid().optional(), bonus: z.coerce.number().int().min(0).max(1_000_000).default(0) }),
        req.query,
      );
      const s = await getStreamerBySlug(ctx.db, slug);
      const settings = await getSettings(ctx.db, s.id);
      const prio = await getPriorityConfig(ctx.db, s.id);
      const sound = q.soundId ? await one<{ price_points: number }>(ctx.db, 'SELECT price_points FROM sounds WHERE id = $1 AND streamer_id = $2 AND deleted_at IS NULL', [q.soundId, s.id]) : null;
      if (q.type === 'SOUND' && !sound) return { enabled: prio.settings.enabled, tiers: [], queueLength: 0 };
      const usage = await many<{ priority_tier: TierKey; last_age: number | null; today: number }>(
        ctx.db,
        `SELECT priority_tier, EXTRACT(EPOCH FROM (now() - MAX(created_at)))::int AS last_age,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today
           FROM messages WHERE sender_id = $1 AND streamer_id = $2 AND status NOT IN ('CANCELLED','REJECTED') GROUP BY priority_tier`,
        [user.id, s.id],
      );
      const byTier = new Map(usage.map((u) => [u.priority_tier, u]));
      const balance = await getBalance(ctx.db, user.id);
      const current = await computeQueue(ctx, s.id);
      const tiers = [];
      for (const t of prio.tiers.filter((x) => x.is_active)) {
        const price = priceFor(q.type, settings, sound, { tier: prio.settings.enabled ? t : null, legacyPriority: false }, q.bonus, false);
        const est = (await computeQueue(ctx, s.id, { tier: t.tier, points: price.total })).hypothetical;
        const u = byTier.get(t.tier);
        const cooldownRemaining = t.cooldown_seconds > 0 && u?.last_age != null ? Math.max(0, t.cooldown_seconds - u.last_age) : 0;
        const dailyRemaining = t.daily_limit > 0 ? Math.max(0, t.daily_limit - (u?.today ?? 0)) : null;
        tiers.push({
          tier: t.tier,
          name: t.name,
          color: t.color,
          icon: t.icon,
          multiplier: t.multiplier,
          price: price.total,
          premium: price.priority,
          affordable: balance >= price.total,
          cooldownRemaining,
          dailyRemaining,
          available: cooldownRemaining === 0 && dailyRemaining !== 0,
          estimatedPosition: est?.position ?? 1,
          messagesAhead: est?.ahead ?? 0,
          estimatedWaitMs: est?.estimatedWaitMs ?? 0,
        });
        if (!prio.settings.enabled) break; // only "Normal" when the priority queue is off
      }
      return { enabled: prio.settings.enabled, defaultTier: prio.settings.default_tier, balance, queueLength: current.items.length + (current.nowPlaying ? 1 : 0), tiers };
    });

    app.get('/api/sound-categories', async () => ({ items: await listCategories(ctx.db) }));

    app.get('/api/points/packages', async () => ({
      items: await many(ctx.db, 'SELECT id, name, points, bonus_label, price_cents, currency FROM points_packages WHERE is_active ORDER BY sort_order, price_cents'),
    }));

    app.post('/api/reports', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const u = requireUser(req);
      const b = parse(
        z.object({ targetType: z.enum(['MESSAGE', 'USER', 'SOUND', 'STREAMER']), targetId: z.string().uuid(), reason: z.string().trim().min(3).max(500) }),
        req.body,
      );
      const r = await one<{ id: string }>(ctx.db, `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1,$2,$3,$4) RETURNING id`, [
        u.id,
        b.targetType,
        b.targetId,
        cleanText(b.reason, 500),
      ]);
      return { id: r!.id };
    });
  };
