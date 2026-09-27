import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { Outbox } from '../events/bus.js';
import { completeOAuth, revokeKickTokens, safeRedirect, startOAuth, type OAuthIntent } from '../auth/oauth.js';
import { OAUTH_COOKIE, revokeAllSessions, revokeSession, SESSION_COOKIE, SESSION_TTL_DAYS } from '../auth/sessions.js';
import { applyPoints, getBalance } from '../services/points.js';
import { audit } from '../services/audit.js';
import { notify } from '../services/notifications.js';
import { staffChannels } from '../services/streamers.js';
import { noStore, parse, requireUser } from '../http.js';

export const authRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const secure = ctx.config.isProd;
    const ipHash = (req: FastifyRequest) => ctx.secrets.hashIp(req.ip);

    const begin = async (req: FastifyRequest, reply: FastifyReply, intent: OAuthIntent, next: string) => {
      const { url, browserNonce } = await startOAuth(ctx, intent, next);
      reply.setCookie(OAUTH_COOKIE, browserNonce, { httpOnly: true, sameSite: 'lax', secure, path: '/auth', maxAge: 600 });
      return url;
    };

    // GET for plain links, POST for fetch() callers — both start the same flow.
    app.get('/auth/kick', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const q = req.query as { next?: string };
      return reply.redirect(await begin(req, reply, 'login', safeRedirect(q.next)));
    });
    app.post('/auth/kick', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = (req.body ?? {}) as { next?: string };
      return { url: await begin(req, reply, 'login', safeRedirect(b.next)) };
    });
    /** Streamer sign-in / sign-up in one step (requests channel + event scopes). */
    app.get('/auth/kick/streamer', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      return reply.redirect(await begin(req, reply, 'streamer_signup', '/streamer/dashboard'));
    });
    app.post('/api/me/connect-channel', async (req, reply) => {
      requireUser(req);
      return { url: await begin(req, reply, 'connect_channel', '/streamer/dashboard') };
    });

    app.get('/auth/kick/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const q = req.query as { code?: string; state?: string; error?: string };
      noStore(reply);
      try {
        const r = await completeOAuth(ctx, {
          code: q.code,
          state: q.state,
          error: q.error,
          browserNonce: req.cookies[OAUTH_COOKIE],
          ipHash: ipHash(req),
          userAgent: req.headers['user-agent'] ?? null,
          currentUser: req.user,
        });
        if (req.session) await revokeSession(ctx.db, req.session.id); // rotate on login
        reply.clearCookie(OAUTH_COOKIE, { path: '/auth' });
        reply.setCookie(SESSION_COOKIE, r.sessionToken, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_TTL_DAYS * 86400 });
        const dest = r.isNewUser && (r.redirectTo === '/home' || r.redirectTo === '/dashboard') ? '/home?welcome=1' : r.redirectTo;
        return reply.redirect(dest);
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'KICK_AUTH_FAILED';
        if (!(err instanceof AppError)) ctx.log.error({ err }, 'oauth callback failed');
        reply.clearCookie(OAUTH_COOKIE, { path: '/auth' });
        const page = (err as { intent?: string }).intent === 'streamer_signup' ? '/streamer/login' : '/login';
        return reply.redirect(`${page}?error=${encodeURIComponent(code.toLowerCase())}`);
      }
    });

    app.post('/auth/logout', async (req, reply) => {
      if (req.session) {
        await revokeSession(ctx.db, req.session.id);
        await audit(ctx.db, { actorUserId: req.user?.id ?? null, action: 'auth.logout', entityType: 'session', entityId: req.session.id, ipHash: ipHash(req) });
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/api/me', async (req, reply) => {
      noStore(reply);
      if (!req.user || !req.session) return { user: null, csrfToken: null };
      const u = req.user;
      const kick = await one<{ kick_user_id: string; kick_username: string; profile_picture: string | null; scopes: string; has_tokens: boolean; tokens_revoked_at: Date | null }>(
        ctx.db,
        `SELECT kick_user_id, kick_username, profile_picture, scopes, (access_token_enc IS NOT NULL) AS has_tokens, tokens_revoked_at FROM kick_accounts WHERE user_id = $1`,
        [u.id],
      );
      const profile = await one<{ bio: string; created_at: Date; last_daily_bonus: string | null }>(
        ctx.db,
        `SELECT bio, created_at, to_char(last_daily_bonus, 'YYYY-MM-DD') AS last_daily_bonus FROM users WHERE id = $1`,
        [u.id],
      );
      const unread = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]);
      return {
        user: {
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          avatarUrl: u.avatar_url,
          role: u.role,
          status: u.status,
          bio: profile?.bio ?? '',
          reducedMotion: u.reduced_motion,
          createdAt: profile?.created_at,
          dailyBonusAvailable: ctx.config.DAILY_BONUS_POINTS > 0 && profile?.last_daily_bonus !== new Date().toISOString().slice(0, 10),
        },
        kick: kick && {
          userId: kick.kick_user_id,
          username: kick.kick_username,
          profilePicture: kick.profile_picture,
          channelTokens: kick.has_tokens && !kick.tokens_revoked_at,
          scopes: kick.scopes ? kick.scopes.split(' ') : [],
        },
        channels: await staffChannels(ctx.db, u.id),
        points: await getBalance(ctx.db, u.id),
        unreadNotifications: unread!.n,
        csrfToken: req.session.csrf_token,
      };
    });

    app.patch('/api/me', async (req) => {
      const u = requireUser(req);
      const body = parse(
        z.object({ displayName: z.string().trim().min(2).max(40).optional(), bio: z.string().max(300).optional(), reducedMotion: z.boolean().optional() }).strict(),
        req.body,
      );
      await ctx.db.query(
        `UPDATE users SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), reduced_motion = COALESCE($4, reduced_motion), updated_at = now() WHERE id = $1`,
        [u.id, body.displayName ? cleanText(body.displayName, 40) : null, body.bio !== undefined ? cleanText(body.bio, 300) : null, body.reducedMotion ?? null],
      );
      await audit(ctx.db, { actorUserId: u.id, action: 'profile.updated', entityType: 'user', entityId: u.id, metadata: { fields: Object.keys(body) } });
      return { ok: true };
    });

    /** Subscriptions and gift subs this user made on Kick (from verified webhooks), grouped per channel. */
    app.get('/api/me/subscriptions', async (req) => {
      const u = requireUser(req);
      const channels = await many<{ streamer_id: string; slug: string; display_name: string; avatar_url: string | null; is_live: boolean; months: number; last_sub_at: Date | null; gifts: number; last_gift_at: Date | null; points_earned: number }>(
        ctx.db,
        `WITH subs AS (
           SELECT streamer_id, MAX(duration_months) AS months, MAX(created_at) AS last_sub_at, SUM(reward_points)::int AS pts
             FROM subscriptions WHERE user_id = $1 AND kind <> 'GIFTED' GROUP BY streamer_id),
         gifts AS (
           SELECT streamer_id, SUM(gift_count)::int AS gifts, MAX(created_at) AS last_gift_at, SUM(reward_points)::int AS pts
             FROM gift_subscriptions WHERE gifter_user_id = $1 GROUP BY streamer_id)
         SELECT s.id AS streamer_id, s.slug, s.display_name, s.avatar_url, s.is_live,
                COALESCE(subs.months, 0) AS months, subs.last_sub_at, COALESCE(gifts.gifts, 0) AS gifts, gifts.last_gift_at,
                COALESCE(subs.pts, 0) + COALESCE(gifts.pts, 0) AS points_earned
           FROM streamers s LEFT JOIN subs ON subs.streamer_id = s.id LEFT JOIN gifts ON gifts.streamer_id = s.id
          WHERE (subs.streamer_id IS NOT NULL OR gifts.streamer_id IS NOT NULL) AND s.deleted_at IS NULL
          ORDER BY GREATEST(COALESCE(subs.last_sub_at, 'epoch'), COALESCE(gifts.last_gift_at, 'epoch')) DESC
          LIMIT 100`,
        [u.id],
      );
      const received = await one<{ n: number }>(ctx.db, `SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1 AND kind = 'GIFTED'`, [u.id]);
      return { items: channels, giftedToYou: received!.n };
    });

    app.get('/api/me/sessions', async (req) => {
      const u = requireUser(req);
      const rows = await many<{ id: string; user_agent: string; created_at: Date; last_seen_at: Date }>(
        ctx.db,
        `SELECT id, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 20`,
        [u.id],
      );
      return { items: rows.map((r) => ({ ...r, current: r.id === req.session!.id })) };
    });

    app.post('/api/me/sessions/revoke-others', async (req) => {
      const u = requireUser(req);
      const n = await revokeAllSessions(ctx.db, u.id, req.session!.id);
      const outbox = new Outbox();
      await notify(ctx.db, outbox, u.id, 'security', 'Signed out of other devices', `${n} session(s) were ended.`);
      outbox.flush(ctx.bus);
      await audit(ctx.db, { actorUserId: u.id, action: 'auth.sessions_revoked', entityType: 'user', entityId: u.id, metadata: { count: n }, ipHash: ipHash(req) });
      return { revoked: n };
    });

    app.post('/api/me/kick/revoke-tokens', async (req) => {
      const u = requireUser(req);
      await revokeKickTokens(ctx, u.id);
      const outbox = new Outbox();
      await notify(ctx.db, outbox, u.id, 'security', 'Kick access revoked', 'VoxDrop no longer holds tokens for your Kick channel. Reconnect to resume sub rewards.');
      outbox.flush(ctx.bus);
      return { ok: true };
    });

    /** Daily check-in: one supported way to earn points. Idempotent per UTC day. */
    app.post('/api/me/daily-bonus', async (req) => {
      const u = requireUser(req);
      const amount = ctx.config.DAILY_BONUS_POINTS;
      if (amount <= 0) throw Errors.featureDisabled('Daily bonus is disabled');
      const day = new Date().toISOString().slice(0, 10);
      const outbox = new Outbox();
      const r = await ctx.db.tx(async (q) => {
        const upd = await q.query(`UPDATE users SET last_daily_bonus = $2::date WHERE id = $1 AND (last_daily_bonus IS NULL OR last_daily_bonus < $2::date)`, [u.id, day]);
        if (!upd.rowCount) throw Errors.conflict('You already claimed today\'s bonus', 'ALREADY_CLAIMED');
        return applyPoints(q, { userId: u.id, type: 'POINTS_EARNED', amount, description: 'Daily check-in bonus', idempotencyKey: `daily:${u.id}:${day}` }, outbox);
      });
      outbox.flush(ctx.bus);
      return { awarded: amount, balance: r.balance };
    });
  };
