import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { isUniqueViolation, many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { decodeCursor, keyset, pageOf, pageQuery } from '../lib/pagination.js';
import { Outbox, Topic } from '../events/bus.js';
import { streamerAccessToken } from '../auth/oauth.js';
import { KICK_EVENTS } from '../integrations/kick/types.js';
import { channelAnalytics, channelDashboard, parseRange } from '../services/analytics.js';
import { audit } from '../services/audit.js';
import { rejectPendingFromUser } from '../services/messages.js';
import { getMessageViews, toMessageView } from '../services/messageView.js';
import { listBans, moderateUser } from '../services/moderation.js';
import { notify } from '../services/notifications.js';
import { applyPoints } from '../services/points.js';
import { getQueue, playNext, reorderQueue, setPaused, skipItem } from '../services/queue.js';
import { listDonationsForChannel, refundDonation } from '../services/payments.js';
import {
  getSettings,
  getStreamer,
  ownStreamer,
  profileSchema,
  publicStreamer,
  requireChannel,
  settingsSchema,
  updateProfile,
  updateSettings,
} from '../services/streamers.js';
import { parse, requireUser, sidParam } from '../http.js';
import { playbackLog, prepareItem, previewAudio, testOnStream } from '../services/announcements.js';
import { resetQueueOrder, schedulePositions, tryAdvance, warm } from '../services/queue.js';
import { getPriorityConfig, prioritySettingsSchema, tierPatchSchema } from '../services/priority.js';
import { listOverlays, OVERLAY_KINDS, rotateOverlayToken } from '../services/overlays.js';
import { ALERT_KINDS, alertSettingsSchema, getAlertSettings, listAlertEvents, testAlert } from '../services/alerts.js';

const STATUS_TABS = ['PENDING', 'APPROVED', 'QUEUED', 'PLAYING', 'PLAYED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;

export const channelRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const ipHash = (req: FastifyRequest) => ctx.secrets.hashIp(req.ip);
    const staff = async (req: FastifyRequest, need: 'moderate' | 'manage') => {
      const user = requireUser(req);
      const { sid } = parse(sidParam, req.params);
      const access = await requireChannel(ctx.db, user, sid, need);
      return { user, sid, access };
    };

    // ── Shortcuts for the signed-in streamer's own channel ───────────────────
    const own = async (req: FastifyRequest) => {
      const user = requireUser(req);
      const s = await ownStreamer(ctx.db, user.id);
      if (!s) throw Errors.forbidden('Connect your Kick channel to use the streamer dashboard');
      return s;
    };
    app.get('/api/streamer/dashboard', async (req) => channelDashboard(ctx.db, (await own(req)).id));
    app.get('/api/streamer/analytics', async (req) => {
      const q = req.query as { range?: string; from?: string; to?: string };
      return channelAnalytics(ctx.db, (await own(req)).id, parseRange(q.range, q.from, q.to));
    });

    // ── Overview ─────────────────────────────────────────────────────────────
    app.get('/api/channels/:sid', async (req) => {
      const { sid, access } = await staff(req, 'moderate');
      const s = await getStreamer(ctx.db, sid);
      return { channel: { ...publicStreamer(s, await getSettings(ctx.db, sid)), queuePaused: s.queue_paused, status: s.status }, access };
    });
    app.get('/api/channels/:sid/dashboard', async (req) => {
      const { sid, access } = await staff(req, 'moderate');
      const d = await channelDashboard(ctx.db, sid);
      // Revenue is owner/admin-only; moderators get the operational view.
      if (access === 'moderator') return { ...d, cards: { ...d.cards, todayDonations: [] }, recentDonations: [], topSupporters: d.topSupporters.map((s) => ({ ...s, donated_cents: 0 })) };
      return d;
    });
    app.get('/api/channels/:sid/analytics', async (req) => {
      const { sid } = await staff(req, 'manage');
      const q = req.query as { range?: string; from?: string; to?: string };
      return channelAnalytics(ctx.db, sid, parseRange(q.range, q.from, q.to));
    });

    // ── Settings / profile / overlay ─────────────────────────────────────────
    app.get('/api/channels/:sid/settings', async (req) => ({ settings: await getSettings(ctx.db, (await staff(req, 'moderate')).sid) }));
    app.patch('/api/channels/:sid/settings', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const settings = await updateSettings(ctx.db, user, sid, parse(settingsSchema, req.body), ipHash(req));
      warm(ctx, sid); // re-generate announcements for queued items with the new voice/template
      ctx.bus.publish(`overlay:${sid}`, 'overlay.settings', { volume: settings.playback_volume, alertStyle: settings.alert_style, showAvatar: settings.overlay_show_avatar, showPoints: settings.overlay_show_points, alertDurationMs: settings.alert_duration_ms, announcementVolume: settings.announce_volume });
      return { settings };
    });
    app.patch('/api/channels/:sid/profile', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const s = await updateProfile(ctx.db, user, sid, parse(profileSchema, req.body));
      ctx.bus.publish(`overlay:${sid}`, 'overlay.settings', { brandColor: s.brand_color });
      return { channel: publicStreamer(s) };
    });
    // Back-compat: the voice/MP3 overlay URL (Integrations page, older clients).
    app.get('/api/channels/:sid/overlay', async (req) => {
      const { sid } = await staff(req, 'manage');
      const audio = (await listOverlays(ctx, sid)).find((o) => o.kind === 'audio')!;
      return { overlayUrl: audio.url, connected: audio.connected };
    });
    app.post('/api/channels/:sid/overlay/rotate', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      return { overlayUrl: await rotateOverlayToken(ctx, user, sid, 'audio') };
    });
    /** All four OBS Browser Source URLs (owner/admin only — they contain secret tokens). */
    app.get('/api/channels/:sid/overlays', async (req) => {
      const { sid } = await staff(req, 'manage');
      return { items: await listOverlays(ctx, sid) };
    });
    app.post('/api/channels/:sid/overlays/:kind/rotate', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const { kind } = parse(z.object({ kind: z.enum(OVERLAY_KINDS) }), req.params);
      return { url: await rotateOverlayToken(ctx, user, sid, kind) };
    });

    // ── Alerts (subscription / gift sub / donation) ───────────────────────────
    app.get('/api/channels/:sid/alerts', async (req) => {
      const { sid } = await staff(req, 'moderate');
      return { settings: await getAlertSettings(ctx.db, sid) };
    });
    app.patch('/api/channels/:sid/alerts/:kind', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const { kind } = parse(z.object({ kind: z.enum(ALERT_KINDS) }), req.params);
      const patch = parse(alertSettingsSchema, req.body);
      await getAlertSettings(ctx.db, sid);
      if (patch.template !== undefined) {
        patch.template = cleanText(patch.template, 120);
        if (!patch.template) throw Errors.validation('Template cannot be empty');
      }
      if (patch.custom_message !== undefined) patch.custom_message = cleanText(patch.custom_message, 160);
      if (patch.sound_id) {
        const snd = await one(ctx.db, 'SELECT 1 FROM sounds WHERE id = $1 AND streamer_id = $2 AND deleted_at IS NULL', [patch.sound_id, sid]);
        if (!snd) throw Errors.validation('Choose a sound from your own library');
      }
      const keys = Object.keys(patch) as Array<keyof typeof patch>;
      if (keys.length) {
        await ctx.db.query(`UPDATE streamer_alert_settings SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE streamer_id = $1 AND kind = $2`, [
          sid,
          kind,
          ...keys.map((k) => patch[k]),
        ]);
        await audit(ctx.db, { actorUserId: user.id, streamerId: sid, action: 'settings.alerts_updated', entityType: 'streamer_alert_settings', entityId: kind, metadata: { fields: keys }, ipHash: ipHash(req) });
      }
      return { settings: (await getAlertSettings(ctx.db, sid))[kind] };
    });
    /** Staff-only test alert (flagged isTest; creates no points/subscription/donation). */
    app.post('/api/channels/:sid/alerts/:kind/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      const { kind } = parse(z.object({ kind: z.enum(ALERT_KINDS) }), req.params);
      return testAlert(ctx, user, sid, kind);
    });
    app.get('/api/channels/:sid/alert-events', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(pageQuery.extend({ kind: z.enum(ALERT_KINDS).optional() }), req.query);
      return pageOf(await listAlertEvents(ctx.db, sid, q.limit, decodeCursor(q.cursor), q.kind), q.limit);
    });

    // ── Priority queue settings (owner/admin) ───────────────────────────────
    const autoPlaybackSchema = z
      .object({
        auto_play: z.boolean(),
        auto_play_delay_seconds: z.union([z.literal(0), z.literal(2), z.literal(5), z.literal(10)]),
        queue_limit: z.number().int().min(1).max(1000),
        cooldown_seconds: z.number().int().min(0).max(86400),
        refund_on_reject: z.boolean(),
      })
      .partial()
      .strict();
    /** The UI offers 0 / 2 / 5 / 10 s; a gap set elsewhere (general settings) is shown as the nearest option. */
    const nearestDelay = (ms: number) => [0, 2, 5, 10].reduce((best, d) => (Math.abs(d * 1000 - ms) < Math.abs(best * 1000 - ms) ? d : best), 0);
    const priorityView = async (sid: string) => {
      const p = await getPriorityConfig(ctx.db, sid);
      const s = await getSettings(ctx.db, sid);
      return {
        settings: p.settings,
        playback: { auto_play: s.auto_play, auto_play_delay_seconds: nearestDelay(s.playback_gap_ms), queue_limit: s.queue_limit, cooldown_seconds: s.cooldown_seconds, refund_on_reject: s.refund_on_reject },
        tiers: p.tiers,
        formula: 'score = 10 × tier multiplier + pointsWeight × points ÷ 100 + waitingWeight × seconds waited ÷ 10; items waiting longer than the starvation cap play next',
      };
    };
    app.get('/api/channels/:sid/priority', async (req) => priorityView((await staff(req, 'moderate')).sid));
    app.patch('/api/channels/:sid/priority', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const b = parse(z.object({ settings: prioritySettingsSchema.optional(), playback: autoPlaybackSchema.optional(), tiers: z.array(tierPatchSchema).max(4).optional() }).strict(), req.body);
      await getPriorityConfig(ctx.db, sid); // ensure defaults exist
      await ctx.db.tx(async (q) => {
        const before = await getPriorityConfig(q, sid);
        if (b.settings && Object.keys(b.settings).length) {
          const keys = Object.keys(b.settings) as Array<keyof typeof b.settings>;
          await q.query(`UPDATE priority_settings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE streamer_id = $1`, [sid, ...keys.map((k) => b.settings![k])]);
        }
        for (const t of b.tiers ?? []) {
          const { tier, ...rest } = t;
          const keys = Object.keys(rest) as Array<keyof typeof rest>;
          if (!keys.length) continue;
          await q.query(`UPDATE priority_tiers SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now() WHERE streamer_id = $1 AND tier = $2`, [sid, tier, ...keys.map((k) => rest[k])]);
        }
        const after = await getPriorityConfig(q, sid);
        // Tier minimums must rise with the tier, and NORMAL can't be switched off.
        const mins = after.tiers.map((t) => t.min_points);
        if (mins.some((m, i) => i > 0 && m < mins[i - 1]!)) throw Errors.validation('Each tier must cost at least as much as the tier below it');
        if (!after.tierMap.get('NORMAL')!.is_active) throw Errors.validation('The Normal tier cannot be disabled');
        if (!after.tierMap.get(after.settings.default_tier)?.is_active) throw Errors.validation('The default tier must be active');
        if (b.playback) {
          const map: Record<string, unknown> = { ...b.playback };
          if (map.auto_play_delay_seconds !== undefined) {
            map.playback_gap_ms = Number(map.auto_play_delay_seconds) * 1000;
            delete map.auto_play_delay_seconds;
          }
          const keys = Object.keys(map);
          if (keys.length) await q.query(`UPDATE streamer_settings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE streamer_id = $1`, [sid, ...keys.map((k) => map[k])]);
        }
        await audit(q, { actorUserId: user.id, streamerId: sid, action: 'settings.priority_updated', entityType: 'priority_settings', entityId: sid, metadata: { before: { settings: before.settings, tiers: before.tiers }, patch: b }, ipHash: ipHash(req) });
      });
      ctx.bus.publish(Topic.channel(sid), 'queue.updated', { streamerId: sid });
      schedulePositions(ctx, sid);
      void tryAdvance(ctx, sid);
      return priorityView(sid);
    });
    app.post('/api/channels/:sid/queue/reset-order', async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      return { cleared: await resetQueueOrder(ctx, user, sid) };
    });

    // ── Voice announcements ─────────────────────────────────────────────────
    app.get('/api/channels/:sid/tts/voices', async (req) => {
      await staff(req, 'moderate');
      let voices: Awaited<ReturnType<typeof ctx.tts.listVoices>> = [];
      let error: string | null = null;
      try {
        voices = await ctx.tts.listVoices();
      } catch (err) {
        error = (err as Error).message;
      }
      return { provider: ctx.tts.name, available: ctx.tts.available, mock: ctx.tts.name === 'mock', voices, error };
    });

    const previewBody = z
      .object({
        kind: z.enum(['VOICE', 'MP3', 'DONATION', 'SOUND']).optional(),
        viewerName: z.string().max(60).optional(),
        announce_voice: z.string().max(100).optional(),
        announce_locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
        announce_speed: z.number().min(0.5).max(2).optional(),
        announce_template_voice: z.string().max(120).optional(),
        announce_template_mp3: z.string().max(120).optional(),
        announce_template_donation: z.string().max(120).optional(),
        announce_template_sound: z.string().max(120).optional(),
      })
      .strict();
    /** Renders a sample with the (unsaved) draft settings and returns WAV audio. */
    app.post('/api/channels/:sid/announcements/preview', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { sid } = await staff(req, 'manage');
      const { wav, text } = await previewAudio(ctx, sid, parse(previewBody, req.body));
      reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store').header('X-Announcement-Text', encodeURIComponent(text));
      return reply.send(wav);
    });
    app.post('/api/channels/:sid/announcements/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { sid } = await staff(req, 'moderate');
      return testOnStream(ctx, sid);
    });
    /** Generates (or returns the cached) announcement for one queued item — used by the queue's preview button. */
    app.post('/api/channels/:sid/queue/:itemId/announcement', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const { itemId } = parse(z.object({ itemId: z.string().uuid() }), req.params);
      const exists = await one(ctx.db, 'SELECT 1 FROM playback_queue WHERE id = $1 AND streamer_id = $2', [itemId, sid]);
      if (!exists) throw Errors.notFound('Queue item');
      return { announcement: await prepareItem(ctx, itemId) };
    });
    app.get('/api/channels/:sid/playback-log', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(pageQuery, req.query);
      return playbackLog(ctx.db, sid, q.limit, decodeCursor(q.cursor));
    });

    // ── Live queue ───────────────────────────────────────────────────────────
    app.get('/api/channels/:sid/queue', async (req) => getQueue(ctx, (await staff(req, 'moderate')).sid));
    app.post('/api/channels/:sid/queue/play-next', async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      const b = parse(z.object({ force: z.boolean().optional() }), req.body);
      const r = await playNext(ctx, sid, user, { force: b.force ?? false });
      if (!r) {
        const busy = await one(ctx.db, `SELECT 1 FROM playback_queue WHERE streamer_id = $1 AND status = 'PLAYING'`, [sid]);
        throw busy ? Errors.conflict('Something is already playing — skip it or use force', 'ALREADY_PLAYING') : Errors.conflict('The queue is empty', 'QUEUE_EMPTY');
      }
      return { playing: r };
    });
    app.post('/api/channels/:sid/queue/pause', async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      await setPaused(ctx, user, sid, true);
      return { paused: true };
    });
    app.post('/api/channels/:sid/queue/resume', async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      await setPaused(ctx, user, sid, false);
      return { paused: false };
    });
    app.post('/api/channels/:sid/queue/skip', async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      const b = parse(z.object({ itemId: z.string().uuid() }), req.body);
      return { skipped: await skipItem(ctx, user, sid, b.itemId) };
    });
    app.post('/api/channels/:sid/queue/reorder', async (req) => {
      const { user, sid } = await staff(req, 'moderate');
      const b = parse(z.object({ itemIds: z.array(z.string().uuid()).max(500) }), req.body);
      await reorderQueue(ctx, user, sid, b.itemIds);
      return getQueue(ctx, sid);
    });

    // ── Messages / moderation queue ──────────────────────────────────────────
    app.get('/api/channels/:sid/messages', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(
        pageQuery.extend({
          status: z.string().max(80).optional(),
          flagged: z.enum(['true', 'false']).optional(),
          type: z.enum(['TEXT', 'VOICE', 'MP3', 'SOUND']).optional(),
          q: z.string().max(60).optional(),
          sender: z.string().uuid().optional(),
        }),
        req.query,
      );
      const params: unknown[] = [sid];
      let where = 'm.streamer_id = $1 AND m.deleted_at IS NULL';
      if (q.status) {
        const statuses = q.status.split(',').filter((s): s is (typeof STATUS_TABS)[number] => (STATUS_TABS as readonly string[]).includes(s));
        if (!statuses.length) throw Errors.validation('Unknown status filter');
        const ph = statuses.map((st) => {
          params.push(st);
          return `$${params.length}::message_status`;
        });
        where += ` AND m.status IN (${ph.join(',')})`;
      }
      if (q.flagged === 'true') where += ' AND m.flagged';
      if (q.type) {
        params.push(q.type);
        where += ` AND m.type = $${params.length}`;
      }
      if (q.sender) {
        params.push(q.sender);
        where += ` AND m.sender_id = $${params.length}`;
      }
      if (q.q) {
        params.push(`%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
        where += ` AND (m.text_content ILIKE $${params.length} OR u.username ILIKE $${params.length})`;
      }
      where += keyset('m', decodeCursor(q.cursor), params);
      // Pending review is oldest-first (FIFO); everything else newest-first.
      const asc = q.status === 'PENDING'; // FIFO review
      const rows = await getMessageViews(ctx.db, where.replace(/< \(\$/, asc ? '> ($' : '< ($'), params, `ORDER BY m.created_at ${asc ? 'ASC' : 'DESC'}, m.id ${asc ? 'ASC' : 'DESC'} LIMIT ${q.limit + 1}`);
      const page = pageOf(rows, q.limit);
      const counts = await one<Record<string, number>>(
        ctx.db,
        `SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS "PENDING", COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS "APPROVED",
                COUNT(*) FILTER (WHERE status = 'QUEUED')::int AS "QUEUED", COUNT(*) FILTER (WHERE status = 'PLAYING')::int AS "PLAYING",
                COUNT(*) FILTER (WHERE flagged AND status IN ('PENDING','APPROVED','QUEUED'))::int AS "FLAGGED"
           FROM messages WHERE streamer_id = $1 AND deleted_at IS NULL`,
        [sid],
      );
      return { items: page.items.map(toMessageView), nextCursor: page.nextCursor, counts };
    });

    // ── Viewers & moderation ─────────────────────────────────────────────────
    app.get('/api/channels/:sid/users', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(z.object({ q: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
      const params: unknown[] = [sid];
      let filter = '';
      if (q.q) {
        params.push(`%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
        filter = ` AND (u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`;
      }
      const rows = await many(
        ctx.db,
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status AS account_status,
                COUNT(m.id)::int AS messages, COALESCE(SUM(m.points_spent),0)::int AS points_spent, MAX(m.created_at) AS last_message_at,
                (SELECT b.kind FROM bans b WHERE b.user_id = u.id AND b.streamer_id = $1 AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now())
                  ORDER BY (b.kind = 'BAN') DESC LIMIT 1) AS restriction,
                (SELECT b.expires_at FROM bans b WHERE b.user_id = u.id AND b.streamer_id = $1 AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now())
                  ORDER BY (b.kind = 'BAN') DESC LIMIT 1) AS restriction_expires_at,
                EXISTS (SELECT 1 FROM streamer_moderators sm WHERE sm.streamer_id = $1 AND sm.user_id = u.id) AS is_moderator
           FROM users u JOIN messages m ON m.sender_id = u.id AND m.streamer_id = $1
          WHERE u.deleted_at IS NULL ${filter}
          GROUP BY u.id ORDER BY last_message_at DESC LIMIT ${q.limit}`,
        params,
      );
      return { items: rows };
    });

    const userAction = z.object({ reason: z.string().max(300).optional(), minutes: z.number().int().min(1).max(43200).optional() });
    for (const action of ['warn', 'mute', 'unmute', 'ban', 'unban'] as const) {
      app.post(`/api/channels/:sid/users/:userId/${action}`, async (req) => {
        const { user, sid } = await staff(req, 'moderate');
        const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
        const b = parse(userAction, req.body);
        return moderateUser(ctx, user, sid, userId, action.toUpperCase() as 'WARN', { ...b, ipHash: ipHash(req) }, rejectPendingFromUser);
      });
    }

    app.post('/api/channels/:sid/users/:userId/grant-points', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
      const b = parse(z.object({ amount: z.number().int().min(1).max(100_000), reason: z.string().trim().min(3).max(200) }), req.body);
      if (userId === user.id) throw Errors.forbidden('You cannot grant points to yourself');
      const settings = await getSettings(ctx.db, sid);
      const outbox = new Outbox();
      const r = await ctx.db.tx(async (q) => {
        await q.query('SELECT id FROM streamers WHERE id = $1 FOR UPDATE', [sid]);
        const granted = await one<{ n: number }>(
          q,
          `SELECT COALESCE(SUM(amount),0)::int AS n FROM points_transactions WHERE streamer_id = $1 AND type = 'POINTS_REWARDED' AND reference_type = 'streamer_grant' AND created_at >= date_trunc('day', now())`,
          [sid],
        );
        if (granted!.n + b.amount > settings.streamer_grant_daily_cap) {
          throw Errors.limitReached(`Daily grant cap reached (${granted!.n}/${settings.streamer_grant_daily_cap} points today)`, { cap: settings.streamer_grant_daily_cap });
        }
        const target = await one(q, 'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
        if (!target) throw Errors.notFound('User');
        const s = await getStreamer(q, sid);
        const tx = await applyPoints(
          q,
          { userId, streamerId: sid, type: 'POINTS_REWARDED', amount: b.amount, description: `Gift from ${s.display_name}: ${cleanText(b.reason, 120)}`, referenceType: 'streamer_grant', referenceId: sid, createdBy: user.id },
          outbox,
        );
        await notify(q, outbox, userId, 'points.received', `+${b.amount} points from ${s.display_name}`, cleanText(b.reason, 200), { streamerId: sid });
        await audit(q, { actorUserId: user.id, streamerId: sid, action: 'points.granted', entityType: 'user', entityId: userId, metadata: { amount: b.amount, reason: b.reason }, ipHash: ipHash(req) });
        return tx;
      });
      outbox.flush(ctx.bus);
      return { transactionId: r.tx.id };
    });

    app.get('/api/channels/:sid/bans', async (req) => ({ items: await listBans(ctx.db, (await staff(req, 'moderate')).sid) }));

    app.get('/api/channels/:sid/moderators', async (req) => {
      const { sid } = await staff(req, 'moderate');
      return {
        items: await many(
          ctx.db,
          `SELECT u.id, u.username, u.display_name, u.avatar_url, m.created_at FROM streamer_moderators m JOIN users u ON u.id = m.user_id WHERE m.streamer_id = $1 ORDER BY m.created_at`,
          [sid],
        ),
      };
    });
    app.post('/api/channels/:sid/moderators', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const b = parse(z.object({ username: z.string().trim().min(2).max(40) }), req.body);
      const target = await one<{ id: string; role: string }>(ctx.db, 'SELECT id, role FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [b.username]);
      if (!target) throw Errors.notFound('User (they must sign in to VoxDrop once first)');
      const s = await getStreamer(ctx.db, sid);
      if (target.id === s.user_id) throw Errors.badRequest('The owner is already staff');
      try {
        await ctx.db.tx(async (q) => {
          await q.query('INSERT INTO streamer_moderators (streamer_id, user_id, added_by) VALUES ($1,$2,$3)', [sid, target.id, user.id]);
          if (target.role === 'VIEWER') await q.query(`UPDATE users SET role = 'MODERATOR' WHERE id = $1`, [target.id]);
          await audit(q, { actorUserId: user.id, streamerId: sid, action: 'moderator.added', entityType: 'user', entityId: target.id });
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw Errors.conflict('Already a moderator');
        throw err;
      }
      const outbox = new Outbox();
      await notify(ctx.db, outbox, target.id, 'security', `You are now a moderator for ${s.display_name}`, 'You can review messages and manage the live queue.', { streamerId: sid });
      outbox.flush(ctx.bus);
      return { ok: true };
    });
    app.delete('/api/channels/:sid/moderators/:userId', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
      await ctx.db.tx(async (q) => {
        const r = await q.query('DELETE FROM streamer_moderators WHERE streamer_id = $1 AND user_id = $2', [sid, userId]);
        if (!r.rowCount) throw Errors.notFound('Moderator');
        await q.query(
          `UPDATE users SET role = 'VIEWER' WHERE id = $1 AND role = 'MODERATOR' AND NOT EXISTS (SELECT 1 FROM streamer_moderators WHERE user_id = $1)`,
          [userId],
        );
        await audit(q, { actorUserId: user.id, streamerId: sid, action: 'moderator.removed', entityType: 'user', entityId: userId });
      });
      return { ok: true };
    });

    // ── History / logs ───────────────────────────────────────────────────────
    app.get('/api/channels/:sid/history', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(pageQuery.extend({ category: z.enum(['all', 'moderation', 'settings', 'sounds', 'points', 'donations', 'queue', 'users']).default('all') }), req.query);
      const prefixes: Record<string, string[]> = {
        moderation: ['message.', 'user.'],
        settings: ['settings.', 'profile.', 'overlay.', 'kick.', 'streamer.'],
        sounds: ['sound.'],
        points: ['points.'],
        donations: ['donation.'],
        queue: ['queue.'],
        users: ['moderator.', 'user.'],
      };
      const params: unknown[] = [sid];
      let where = 'a.streamer_id = $1';
      if (q.category !== 'all') {
        const ors = prefixes[q.category]!.map((p) => {
          params.push(`${p}%`);
          return `a.action LIKE $${params.length}`;
        });
        where += ` AND (${ors.join(' OR ')})`;
      }
      where += keyset('a', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at, u.username AS actor_username, u.avatar_url AS actor_avatar
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/channels/:sid/moderation-actions', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [sid];
      const where = 'ma.streamer_id = $1' + keyset('ma', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT ma.id, ma.action, ma.reason, ma.message_id, ma.created_at, a.username AS actor_username, t.username AS target_username
           FROM moderation_actions ma JOIN users a ON a.id = ma.actor_id LEFT JOIN users t ON t.id = ma.target_user_id
          WHERE ${where} ORDER BY ma.created_at DESC, ma.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/channels/:sid/subscriptions', async (req) => {
      const { sid } = await staff(req, 'moderate');
      const q = parse(pageQuery.extend({ kind: z.enum(['subs', 'gifts']).default('subs') }), req.query);
      const params: unknown[] = [sid];
      if (q.kind === 'gifts') {
        const where = 'g.streamer_id = $1' + keyset('g', decodeCursor(q.cursor), params);
        const rows = await many<{ id: string; created_at: Date }>(
          ctx.db,
          `SELECT g.id, g.gifter_username, g.is_anonymous, g.gift_count, g.reward_points, g.reward_status, g.created_at
             FROM gift_subscriptions g WHERE ${where} ORDER BY g.created_at DESC, g.id DESC LIMIT ${q.limit + 1}`,
          params,
        );
        return pageOf(rows, q.limit);
      }
      const where = 's.streamer_id = $1' + keyset('s', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT s.id, s.kind, s.kick_username, s.duration_months, s.reward_points, s.reward_status, s.created_at, (s.user_id IS NOT NULL) AS linked
           FROM subscriptions s WHERE ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/channels/:sid/points', async (req) => {
      const { sid } = await staff(req, 'manage');
      const q = parse(pageQuery, req.query);
      const params: unknown[] = [sid];
      const where = 't.streamer_id = $1' + keyset('t', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT t.id, t.type, t.amount, t.description, t.created_at, u.username, u.display_name, u.avatar_url
           FROM points_transactions t JOIN users u ON u.id = t.user_id WHERE ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      const totals = await one(
        ctx.db,
        `SELECT COALESCE(SUM(-amount) FILTER (WHERE type = 'POINTS_SPENT'),0)::int AS spent,
                COALESCE(SUM(amount) FILTER (WHERE type = 'POINTS_REWARDED'),0)::int AS rewarded,
                COALESCE(SUM(amount) FILTER (WHERE type = 'POINTS_REFUNDED'),0)::int AS refunded
           FROM points_transactions WHERE streamer_id = $1`,
        [sid],
      );
      return { ...pageOf(rows, q.limit), totals };
    });

    // ── Donations (money — owner/admin only) ─────────────────────────────────
    app.get('/api/channels/:sid/donations', async (req) => {
      const { sid } = await staff(req, 'manage');
      const q = parse(pageQuery.extend({ status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED']).optional() }), req.query);
      const params: unknown[] = [sid];
      if (q.status) params.push(q.status);
      const cursorSql = keyset('d', decodeCursor(q.cursor), params);
      const rows = (await listDonationsForChannel(ctx.db, sid, q.status, q.limit, cursorSql, params)) as Array<{ id: string; created_at: Date }>;
      const summary = await many(
        ctx.db,
        `SELECT currency, status, COUNT(*)::int AS count, COALESCE(SUM(amount_cents),0)::int AS total_cents FROM donations WHERE streamer_id = $1 GROUP BY currency, status`,
        [sid],
      );
      return { ...pageOf(rows, q.limit), summary };
    });
    app.post('/api/channels/:sid/donations/:donationId/refund', async (req) => {
      const { user } = await staff(req, 'manage');
      const { donationId } = parse(z.object({ donationId: z.string().uuid() }), req.params);
      const b = parse(z.object({ reason: z.string().max(200).optional().default('') }), req.body);
      return refundDonation(ctx, user, donationId, b.reason, ipHash(req));
    });

    // ── Integrations ─────────────────────────────────────────────────────────
    app.get('/api/channels/:sid/integrations', async (req) => {
      const { sid } = await staff(req, 'manage');
      const s = await getStreamer(ctx.db, sid);
      const kick = await one<{ kick_username: string; has_tokens: boolean; tokens_revoked_at: Date | null; token_expires_at: Date | null; scopes: string }>(
        ctx.db,
        'SELECT kick_username, (access_token_enc IS NOT NULL) AS has_tokens, tokens_revoked_at, token_expires_at, scopes FROM kick_accounts WHERE user_id = $1',
        [s.user_id],
      );
      const lastEvents = await many(
        ctx.db,
        `SELECT w.event_type, w.status, w.received_at, w.error FROM webhook_events w
          WHERE w.provider = 'kick' AND (w.payload -> 'broadcaster' ->> 'user_id') = $1 ORDER BY w.received_at DESC LIMIT 10`,
        [s.kick_broadcaster_user_id ?? ''],
      );
      return {
        kickMode: ctx.config.KICK_MODE,
        kick: kick && { username: kick.kick_username, connected: kick.has_tokens && !kick.tokens_revoked_at, tokenExpiresAt: kick.token_expires_at, scopes: kick.scopes.split(' ').filter(Boolean) },
        broadcasterUserId: s.kick_broadcaster_user_id,
        eventsSubscribedAt: s.kick_events_subscribed_at,
        webhookUrl: `${ctx.config.APP_URL}/api/webhooks/kick`,
        overlayConnected: ctx.bus.listenerCount(`overlay:${sid}`) > 0,
        lastEvents,
      };
    });
    app.post('/api/channels/:sid/kick/subscribe-events', async (req) => {
      const { user, sid } = await staff(req, 'manage');
      const s = await getStreamer(ctx.db, sid);
      if (s.user_id !== user.id) throw Errors.forbidden('Only the channel owner can connect Kick events');
      const token = await streamerAccessToken(ctx, user.id);
      const ids = await ctx.kickApi.subscribeToEvents(token, KICK_EVENTS);
      await ctx.db.query('UPDATE streamers SET kick_events_subscribed_at = now() WHERE id = $1', [sid]);
      await audit(ctx.db, { actorUserId: user.id, streamerId: sid, action: 'kick.events_subscribed', entityType: 'streamer', entityId: sid, metadata: { subscriptions: ids.length } });
      return { subscriptions: ids.length };
    });
  };
