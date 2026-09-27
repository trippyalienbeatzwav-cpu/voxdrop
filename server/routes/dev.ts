/**
 * ███ DEVELOPMENT-ONLY ROUTES ███
 * Registered only when NODE_ENV !== 'production' AND a mock integration is
 * active. They drive MockKickService / MockPaymentService through the REAL
 * webhook endpoints (signed requests injected into /api/webhooks/*), so the
 * verification, idempotency and fulfilment code under test is production code.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { requireChannel } from '../services/streamers.js';
import { parse, requireUser } from '../http.js';

export const devRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/dev/status', async () => ({
      mocks: { kick: !!ctx.mockKick, payments: !!ctx.mockPayments, storage: ctx.storage.name === 'mock' },
      warning: 'Development mocks are active. Nothing here talks to Kick or moves real money.',
    }));

    if (ctx.mockKick) {
      const mock = ctx.mockKick;

      /** Identities offered on the mock consent screen (seeded demo accounts). */
      app.get('/api/dev/mock-kick/identities', async () => ({
        items: await many(
          ctx.db,
          `SELECT k.kick_user_id, k.kick_username, k.profile_picture, u.role, u.display_name
             FROM kick_accounts k JOIN users u ON u.id = k.user_id WHERE u.deleted_at IS NULL ORDER BY u.role DESC, k.kick_username LIMIT 50`,
        ),
      }));

      app.post('/api/dev/mock-kick/authorize', async (req) => {
        const b = parse(
          z.object({
            state: z.string().min(10).max(200),
            codeChallenge: z.string().min(20).max(200),
            username: z.string().min(3).max(25),
            kickUserId: z.string().regex(/^\d{1,15}$/).optional(),
          }),
          req.body,
        );
        const existing = await one<{ kick_user_id: string; profile_picture: string | null }>(
          ctx.db,
          'SELECT kick_user_id, profile_picture FROM kick_accounts WHERE lower(kick_username) = lower($1)',
          [b.username],
        );
        const kickUserId = existing?.kick_user_id ?? b.kickUserId ?? String(900000000 + Math.floor(Math.random() * 99999999));
        const code = mock.issueCode({ kickUserId, username: b.username, profilePicture: existing?.profile_picture ?? null }, b.codeChallenge);
        return { redirect: `/auth/kick/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(b.state)}` };
      });

      /** Sends a correctly signed Kick webhook for the caller's own channel into /api/webhooks/kick. */
      app.post('/api/dev/kick/simulate', async (req) => {
        const user = requireUser(req);
        const b = parse(
          z.object({
            streamerId: z.string().uuid(),
            type: z.enum(['channel.subscription.new', 'channel.subscription.renewal', 'channel.subscription.gifts', 'channel.followed', 'livestream.status.updated']),
            username: z.string().max(25).optional(),
            giftCount: z.number().int().min(1).max(100).optional().default(1),
            isLive: z.boolean().optional(),
            replayMessageId: z.string().max(60).optional(),
          }),
          req.body,
        );
        await requireChannel(ctx.db, user, b.streamerId, 'manage');
        const s = await one<{ kick_broadcaster_user_id: string; slug: string; display_name: string }>(
          ctx.db,
          'SELECT kick_broadcaster_user_id, slug, display_name FROM streamers WHERE id = $1',
          [b.streamerId],
        );
        if (!s?.kick_broadcaster_user_id) throw Errors.conflict('Channel has no Kick broadcaster id');
        const who = async (username?: string) => {
          if (!username) {
            const n = Math.floor(Math.random() * 1e6);
            return { is_anonymous: false, user_id: 800000000 + n, username: `kick_viewer_${n}`, is_verified: false, profile_picture: null, channel_slug: `kick_viewer_${n}` };
          }
          const k = await one<{ kick_user_id: string; kick_username: string }>(ctx.db, 'SELECT kick_user_id, kick_username FROM kick_accounts WHERE lower(kick_username) = lower($1)', [username]);
          if (!k) throw new AppError(404, 'NOT_FOUND', `No VoxDrop user linked to Kick username "${username}" (leave blank for an unlinked viewer)`);
          return { is_anonymous: false, user_id: Number(k.kick_user_id), username: k.kick_username, is_verified: false, profile_picture: null, channel_slug: k.kick_username.toLowerCase() };
        };
        const broadcaster = { is_anonymous: false, user_id: Number(s.kick_broadcaster_user_id), username: s.display_name, is_verified: true, profile_picture: null, channel_slug: s.slug };
        const now = new Date();
        let payload: Record<string, unknown>;
        switch (b.type) {
          case 'channel.subscription.new':
          case 'channel.subscription.renewal':
            payload = { broadcaster, subscriber: await who(b.username), duration: b.type === 'channel.subscription.new' ? 1 : 3, created_at: now.toISOString(), expires_at: new Date(+now + 30 * 86400_000).toISOString() };
            break;
          case 'channel.subscription.gifts':
            payload = {
              broadcaster,
              gifter: await who(b.username),
              giftees: await Promise.all(Array.from({ length: b.giftCount }, () => who())),
              created_at: now.toISOString(),
              expires_at: new Date(+now + 30 * 86400_000).toISOString(),
            };
            break;
          case 'channel.followed':
            payload = { broadcaster, follower: await who(b.username) };
            break;
          default:
            payload = { broadcaster, is_live: b.isLive ?? true, title: 'Mock stream', started_at: now.toISOString(), ended_at: b.isLive === false ? now.toISOString() : null };
        }
        const signed = mock.signEvent(b.type, payload, { messageId: b.replayMessageId });
        const res = await app.inject({ method: 'POST', url: '/api/webhooks/kick', headers: signed.headers, payload: signed.body });
        return { httpStatus: res.statusCode, response: res.json(), messageId: signed.headers['kick-event-message-id'] };
      });
    }

    if (ctx.mockPayments) {
      const mock = ctx.mockPayments;
      app.get('/api/dev/mock-checkout/:sessionId', async (req) => {
        const { sessionId } = parse(z.object({ sessionId: z.string().max(80) }), req.params);
        const d = mock.describe(sessionId);
        if (!d) throw Errors.notFound('Checkout session');
        return { session: d };
      });
      app.post('/api/dev/mock-checkout/:sessionId/:outcome', async (req) => {
        requireUser(req);
        const { sessionId, outcome } = parse(z.object({ sessionId: z.string().max(80), outcome: z.enum(['pay', 'decline']) }), req.params);
        const d = mock.describe(sessionId);
        if (!d) throw Errors.notFound('Checkout session');
        const signed = mock.simulate(sessionId, outcome === 'pay' ? 'paid' : 'declined');
        const res = await app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: signed.headers, payload: signed.body });
        return { redirect: outcome === 'pay' ? d.successUrl : d.cancelUrl, webhook: { httpStatus: res.statusCode, response: res.json() } };
      });
    }
  };
