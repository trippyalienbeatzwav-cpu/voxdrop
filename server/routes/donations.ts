import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { decodeCursor, keyset, pageOf, pageQuery } from '../lib/pagination.js';
import { createDonation, donationSchema } from '../services/payments.js';
import { idParam, parse, requireUser } from '../http.js';

export const donationRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.post('/api/donations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const r = await createDonation(ctx, requireUser(req), parse(donationSchema, req.body));
      reply.status(201);
      return r;
    });

    app.get('/api/donations', async (req) => {
      const user = requireUser(req);
      const q = parse(pageQuery.extend({ status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED']).optional() }), req.query);
      const params: unknown[] = [user.id];
      let where = 'd.donor_id = $1';
      if (q.status) {
        params.push(q.status);
        where += ` AND d.status = $${params.length}`;
      }
      where += keyset('d', decodeCursor(q.cursor), params);
      const rows = await many<{ id: string; created_at: Date }>(
        ctx.db,
        `SELECT d.id, d.amount_cents, d.currency, d.message, d.status, d.is_anonymous, d.created_at, d.completed_at, d.refunded_at,
                (d.audio_file_id IS NOT NULL) AS has_voice, s.slug AS streamer_slug, s.display_name AS streamer_display_name, s.avatar_url AS streamer_avatar
           FROM donations d JOIN streamers s ON s.id = d.streamer_id
          WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${q.limit + 1}`,
        params,
      );
      return pageOf(rows, q.limit);
    });

    app.get('/api/donations/:id', async (req) => {
      const user = requireUser(req);
      const { id } = parse(idParam, req.params);
      const d = await one<{ donor_id: string }>(
        ctx.db,
        `SELECT d.id, d.donor_id, d.amount_cents, d.currency, d.message, d.status, d.created_at, d.completed_at, s.slug AS streamer_slug, s.display_name AS streamer_display_name
           FROM donations d JOIN streamers s ON s.id = d.streamer_id WHERE d.id = $1`,
        [id],
      );
      if (!d || d.donor_id !== user.id) throw Errors.notFound('Donation');
      return { donation: d };
    });
  };
