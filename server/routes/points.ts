import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/client.js';
import { decodeCursor, keyset, pageOf, pageQuery } from '../lib/pagination.js';
import { purchasePoints } from '../services/payments.js';
import { parse, requireUser } from '../http.js';

const TX_TYPES = ['POINTS_EARNED', 'POINTS_SPENT', 'POINTS_SPENT_PRIORITY', 'POINTS_PURCHASED', 'POINTS_REWARDED', 'POINTS_REFUNDED', 'POINTS_ADJUSTED', 'POINTS_EXPIRED'] as const;

export const pointsRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/points', async (req) => {
      const user = requireUser(req);
      const acct = await one<{ balance: number; lifetime_earned: number; lifetime_spent: number }>(
        ctx.db,
        'SELECT balance, lifetime_earned, lifetime_spent FROM points_accounts WHERE user_id = $1',
        [user.id],
      );
      const byType = await many<{ type: string; total: number }>(ctx.db, 'SELECT type, SUM(amount)::int AS total FROM points_transactions WHERE user_id = $1 GROUP BY type', [user.id]);
      return {
        balance: acct?.balance ?? 0,
        lifetimeEarned: acct?.lifetime_earned ?? 0,
        lifetimeSpent: acct?.lifetime_spent ?? 0,
        totalsByType: Object.fromEntries(byType.map((r) => [r.type, r.total])),
      };
    });

    app.get('/api/points/transactions', async (req) => {
      const user = requireUser(req);
      const q = parse(pageQuery.extend({ type: z.enum(TX_TYPES).optional() }), req.query);
      const params: unknown[] = [user.id];
      let where = 't.user_id = $1';
      if (q.type) {
        params.push(q.type);
        where += ` AND t.type = $${params.length}`;
      }
      where += keyset('t', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT t.id, t.type, t.amount, t.balance_before, t.balance_after, t.reference_type, t.reference_id, t.description, t.priority_tier, t.created_at,
                s.slug AS streamer_slug, s.display_name AS streamer_display_name
           FROM points_transactions t LEFT JOIN streamers s ON s.id = t.streamer_id
          WHERE ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.post('/api/points/purchase', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const user = requireUser(req);
      const b = parse(z.object({ packageId: z.string().uuid() }), req.body);
      return purchasePoints(ctx, user, b.packageId);
    });
  };
