import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many } from '../db/client.js';
import { decodeCursor, keyset, pageOf, pageQuery } from '../lib/pagination.js';
import { parse, requireUser } from '../http.js';

export const notificationRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/notifications', async (req) => {
      const user = requireUser(req);
      const q = parse(pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }), req.query);
      const params: unknown[] = [user.id];
      let where = 'n.user_id = $1';
      if (q.unread === 'true') where += ' AND n.read_at IS NULL';
      where += keyset('n', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT n.id, n.type, n.title, n.body, n.data, n.read_at, n.created_at FROM notifications n WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.post('/api/notifications/read', async (req) => {
      const user = requireUser(req);
      const b = parse(z.object({ ids: z.array(z.string().uuid()).max(100).optional(), all: z.boolean().optional() }), req.body);
      if (b.all) await ctx.db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
      else if (b.ids?.length) {
        const ph = b.ids.map((_, i) => `$${i + 2}::uuid`).join(',');
        await ctx.db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id IN (${ph}) AND read_at IS NULL`, [user.id, ...b.ids]);
      }
      return { ok: true };
    });
  };
