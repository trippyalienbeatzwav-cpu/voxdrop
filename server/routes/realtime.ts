import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { Topic, type BusEvent } from '../events/bus.js';
import { finishPlaying, overlayPayload, tryAdvance } from '../services/queue.js';
import { applyPlaybackEvent } from '../services/announcements.js';
import { KIND_OF_PATH, topicFor, verifyOverlayToken } from '../services/overlays.js';
import { ackAlert, getAlertSettings, pendingAlerts } from '../services/alerts.js';
import { getSettings, staffChannels } from '../services/streamers.js';
import type { StreamerRow } from '../services/types.js';
import { parse, requireUser } from '../http.js';

/** Per-process cap on concurrent SSE connections per user (tabs). */
const MAX_STREAMS_PER_USER = 8;
const openStreams = new Map<string, number>();

/**
 * Server-Sent Events: one long-lived HTTP response per client. Chosen over
 * WebSockets because all real-time traffic is server→client, SSE reconnects
 * automatically, and it passes through proxies/CDNs and OBS without extra setup.
 */
function openStream(req: FastifyRequest, reply: FastifyReply, ctx: AppContext, topics: string[], onClose?: () => void, hello?: unknown, initial: BusEvent[] = []) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt: BusEvent) => res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify(hello ?? { ok: true })}\n\n`);
  initial.forEach(send);
  const unsubs = topics.map((t) => ctx.bus.subscribe(t, send));
  // A named event (not an SSE comment) so clients can see it and detect silently dropped streams.
  const heartbeat = setInterval(() => res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`), 25_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubs.forEach((u) => u());
    onClose?.();
  };
  req.raw.on('close', close);
}

export const realtimeRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    /** Authenticated stream: the user's own events + every channel they staff. */
    app.get('/api/realtime', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const user = requireUser(req);
      const n = openStreams.get(user.id) ?? 0;
      if (n >= MAX_STREAMS_PER_USER) throw Errors.limitReached('Too many open real-time connections');
      openStreams.set(user.id, n + 1);
      const channels = await staffChannels(ctx.db, user.id);
      const topics = [Topic.user(user.id), ...channels.map((c) => Topic.channel(c.id))];
      openStream(req, reply, ctx, topics, () => {
        const left = (openStreams.get(user.id) ?? 1) - 1;
        if (left <= 0) openStreams.delete(user.id);
        else openStreams.set(user.id, left);
      }, { channels: channels.map((c) => c.id) });
    });

    /** Public stream for a channel page: live status and queue length only. */
    app.get('/api/streamers/:slug/events', async (req, reply) => {
      const { slug } = parse(z.object({ slug: z.string().min(1).max(60) }), req.params);
      const s = await one<{ id: string }>(ctx.db, 'SELECT id FROM streamers WHERE lower(slug) = lower($1) AND deleted_at IS NULL', [slug]);
      if (!s) throw Errors.notFound('Streamer');
      openStream(req, reply, ctx, [Topic.publicChannel(s.id)]);
    });

    // ── OBS overlays: /api/overlay/:streamerId/:kind?token=… ──────────────────
    // Each Browser Source (audio, subscription, gift-sub, donation) is authenticated
    // by its OWN secret token; one overlay's token cannot open another overlay.
    const overlayParams = z.object({ sid: z.string().uuid(), kind: z.enum(['audio', 'subscription', 'gift-sub', 'donation']) });
    const tokenQuery = z.object({ token: z.string().min(10).max(100) });
    const authOverlay = async (req: FastifyRequest) => {
      const { sid, kind: path } = parse(overlayParams, req.params);
      const { token } = parse(tokenQuery, req.query);
      const kind = KIND_OF_PATH[path]!;
      await verifyOverlayToken(ctx.db, sid, kind, token);
      const s = await one<StreamerRow>(ctx.db, `SELECT * FROM streamers WHERE id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'`, [sid]);
      if (!s) throw Errors.notFound('Overlay');
      return { s, kind };
    };

    app.get('/api/overlay/:sid/:kind', async (req) => {
      const { s, kind } = await authOverlay(req);
      const streamer = { id: s.id, slug: s.slug, displayName: s.display_name, brandColor: s.brand_color, avatarUrl: s.avatar_url };
      if (kind !== 'audio') {
        const a = (await getAlertSettings(ctx.db, s.id))[kind];
        return { kind, streamer, alert: { enabled: a.enabled, position: a.position, animation: a.animation, durationMs: a.duration_ms, volume: a.volume, accentColor: a.accent_color, template: a.template } };
      }
      const settings = await getSettings(ctx.db, s.id);
      const playing = await one<{ id: string; message_id: string }>(ctx.db, `SELECT id, message_id FROM playback_queue WHERE streamer_id = $1 AND status = 'PLAYING'`, [s.id]);
      // Reconnecting mid-item: the payload carries the phase so the overlay resumes at the right step.
      const current = playing ? { ...(await overlayPayload(ctx, playing.message_id, playing.id)), volume: settings.playback_volume } : null;
      return {
        kind,
        streamer,
        settings: {
          paused: s.queue_paused,
          volume: settings.playback_volume,
          alertStyle: settings.alert_style,
          alertDurationMs: settings.alert_duration_ms,
          showAvatar: settings.overlay_show_avatar,
          showPoints: settings.overlay_show_points,
          announcementVolume: settings.announce_volume,
        },
        current,
      };
    });

    app.get('/api/overlay/:sid/:kind/events', async (req, reply) => {
      const { s, kind } = await authOverlay(req);
      if (kind !== 'audio') {
        // Alerts fired while this overlay was offline (last 2 min) are replayed to this connection only.
        const backlog = (await pendingAlerts(ctx.db, s.id, kind)).map((r) => ({ id: String(r.payload.alertId), type: 'alert.show' as const, data: r.payload, ts: new Date().toISOString() }));
        openStream(req, reply, ctx, [topicFor(s.id, kind)], () => ctx.bus.publish(Topic.channel(s.id), 'queue.updated', { streamerId: s.id, overlay: `${kind}:disconnected` }), { kind }, backlog);
        ctx.bus.publish(Topic.channel(s.id), 'queue.updated', { streamerId: s.id, overlay: `${kind}:connected` });
        return;
      }
      openStream(req, reply, ctx, [Topic.overlay(s.id)], () => {
        ctx.bus.publish(Topic.channel(s.id), 'queue.updated', { streamerId: s.id, overlay: 'disconnected' });
      }, { kind });
      ctx.bus.publish(Topic.channel(s.id), 'queue.updated', { streamerId: s.id, overlay: 'connected' });
      // A voice/MP3 overlay just came online: start playing if items are waiting.
      setTimeout(() => void tryAdvance(ctx, s.id), 500);
    });

    /**
     * Voice/MP3 overlay reports REAL audio lifecycle events (from <audio>
     * 'playing', 'ended' and 'error'), never timer guesses. The server state
     * machine rejects out-of-order events (viewer audio before its
     * announcement) and ignores duplicates / events for items no longer playing.
     */
    app.post('/api/overlay/:sid/:kind/playback', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { s, kind } = await authOverlay(req);
      if (kind !== 'audio') throw Errors.notFound('Overlay');
      const b = parse(
        z.object({
          itemId: z.string().uuid(),
          event: z.enum(['started', 'announcement_started', 'announcement_ended', 'announcement_error', 'message_started', 'ended', 'error']),
          detail: z.string().max(200).optional(),
        }),
        req.body,
      );
      const r = await applyPlaybackEvent(ctx, s.id, b.itemId, b.event, b.detail);
      if (!r.ok) return reply.status(409).send({ error: { code: r.error ?? 'OUT_OF_ORDER', message: 'The announcement must finish before the viewer audio plays' } });
      let finished = false;
      if (r.finish) finished = await finishPlaying(ctx, s.id, b.itemId, r.finish, null);
      return { ok: true, ignored: r.ignored ?? null, finished };
    });

    /** Alert overlays acknowledge display so the streamer can see delivery status. */
    app.post('/api/overlay/:sid/:kind/ack', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
      const { s, kind } = await authOverlay(req);
      if (kind === 'audio') throw Errors.notFound('Overlay');
      const b = parse(z.object({ alertId: z.string().uuid(), event: z.enum(['shown', 'completed', 'failed']), detail: z.string().max(200).optional() }), req.body);
      return { ok: true, updated: await ackAlert(ctx.db, s.id, kind, b.alertId, b.event, b.detail) };
    });
  };
