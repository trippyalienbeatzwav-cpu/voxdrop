import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { decodeCursor, keyset, pageOf, pageQuery } from '../lib/pagination.js';
import { Errors } from '../lib/errors.js';
import {
  approveMessage,
  cancelOwnMessage,
  createMessage,
  createMessageSchema,
  deleteMessage,
  playNow,
  queueMessage,
  rejectMessage,
  setFlag,
} from '../services/messages.js';
import { getMessageView, getMessageViews, toMessageView } from '../services/messageView.js';
import { channelAccess } from '../services/streamers.js';
import { positionOf } from '../services/queue.js';
import { idParam, parse, requireUser } from '../http.js';

export const messageRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const ipHash = (req: FastifyRequest) => ctx.secrets.hashIp(req.ip);

    app.post('/api/messages', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } }, async (req, reply) => {
      const user = requireUser(req);
      const body = parse(createMessageSchema, req.body);
      const key = req.headers['idempotency-key'];
      const r = await createMessage(ctx, user, body, typeof key === 'string' ? key : null);
      reply.status(r.replayed ? 200 : 201);
      return { message: r.message, replayed: r.replayed };
    });

    /** The signed-in viewer's own messages. */
    app.get('/api/messages', async (req) => {
      const user = requireUser(req);
      const q = parse(
        pageQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'QUEUED', 'PLAYING', 'PLAYED', 'REJECTED', 'EXPIRED', 'CANCELLED']).optional(), type: z.enum(['TEXT', 'VOICE', 'MP3', 'SOUND']).optional() }),
        req.query,
      );
      const params: unknown[] = [user.id];
      let where = 'm.sender_id = $1 AND m.deleted_at IS NULL';
      if (q.status) {
        params.push(q.status);
        where += ` AND m.status = $${params.length}`;
      }
      if (q.type) {
        params.push(q.type);
        where += ` AND m.type = $${params.length}`;
      }
      where += keyset('m', decodeCursor(q.cursor), params);
      const rows = await getMessageViews(ctx.db, where, params, `ORDER BY m.created_at DESC, m.id DESC LIMIT ${q.limit + 1}`);
      const page = pageOf(rows, q.limit);
      return { items: page.items.map(toMessageView), nextCursor: page.nextCursor };
    });

    app.get('/api/messages/:id', async (req) => {
      const user = requireUser(req);
      const { id } = parse(idParam, req.params);
      const m = await getMessageView(ctx.db, id);
      if (!m) throw Errors.notFound('Message');
      if (m.sender.id !== user.id && !(await channelAccess(ctx.db, user, m.streamerId))) throw Errors.notFound('Message');
      return { message: m };
    });

    /** Live queue position for one of the viewer's own messages (estimate). */
    app.get('/api/messages/:id/position', async (req) => {
      const user = requireUser(req);
      const { id } = parse(idParam, req.params);
      const m = await getMessageView(ctx.db, id);
      if (!m || m.sender.id !== user.id) throw Errors.notFound('Message');
      return { position: await positionOf(ctx, m.streamerId, id), state: m.playbackState };
    });

    app.post('/api/messages/:id/cancel', async (req) => ({ message: await cancelOwnMessage(ctx, requireUser(req), parse(idParam, req.params).id) }));
    app.post('/api/messages/:id/approve', async (req) => ({ message: await approveMessage(ctx, requireUser(req), parse(idParam, req.params).id, ipHash(req)) }));
    app.post('/api/messages/:id/queue', async (req) => ({ message: await queueMessage(ctx, requireUser(req), parse(idParam, req.params).id) }));
    app.post('/api/messages/:id/reject', async (req) => {
      const b = parse(z.object({ reason: z.string().max(200).optional().default('') }), req.body);
      return { message: await rejectMessage(ctx, requireUser(req), parse(idParam, req.params).id, b.reason, ipHash(req)) };
    });
    app.post('/api/messages/:id/flag', async (req) => {
      const b = parse(z.object({ flagged: z.boolean().default(true), reason: z.string().max(200).optional().default('') }), req.body);
      return { message: await setFlag(ctx, requireUser(req), parse(idParam, req.params).id, b.flagged, b.reason) };
    });
    app.post('/api/messages/:id/play-now', async (req) => ({ playing: await playNow(ctx, requireUser(req), parse(idParam, req.params).id) }));
    app.delete('/api/messages/:id', async (req) => deleteMessage(ctx, requireUser(req), parse(idParam, req.params).id, ipHash(req)));
  };
