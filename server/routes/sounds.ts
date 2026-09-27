import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many } from '../db/client.js';
import { createSound, deleteSound, listSounds, soundCreateSchema, soundUpdateSchema, triggerSoundAsStaff, updateSound } from '../services/sounds.js';
import { getStreamerBySlug, requireChannel } from '../services/streamers.js';
import { idParam, parse, requireUser } from '../http.js';

export const soundRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    /** Public library for a channel (`streamer` = slug). Staff can include inactive sounds. */
    app.get('/api/sounds', async (req) => {
      const q = parse(
        z.object({
          streamer: z.string().min(1).max(60),
          category: z.string().max(40).optional(),
          q: z.string().max(60).optional(),
          sort: z.enum(['popular', 'price_asc', 'price_desc', 'newest', 'name', 'custom']).optional(),
          includeInactive: z.enum(['true', 'false']).optional(),
        }),
        req.query,
      );
      const s = await getStreamerBySlug(ctx.db, q.streamer);
      let includeInactive = false;
      if (q.includeInactive === 'true') {
        await requireChannel(ctx.db, requireUser(req), s.id, 'moderate');
        includeInactive = true;
      }
      return { items: await listSounds(ctx.db, { streamerId: s.id, category: q.category, q: q.q, sort: q.sort, includeInactive }) };
    });

    app.get('/api/sounds/recent', async (req) => {
      const user = requireUser(req);
      const { streamer } = parse(z.object({ streamer: z.string().min(1).max(60) }), req.query);
      const s = await getStreamerBySlug(ctx.db, streamer);
      const rows = await many<{ sound_id: string; last_used: Date }>(
        ctx.db,
        `SELECT sound_id, MAX(created_at) AS last_used FROM sound_usage WHERE user_id = $1 AND streamer_id = $2 GROUP BY sound_id ORDER BY last_used DESC LIMIT 8`,
        [user.id, s.id],
      );
      return { items: rows.map((r) => ({ soundId: r.sound_id, lastUsed: r.last_used })) };
    });

    app.post('/api/sounds', async (req, reply) => {
      const sound = await createSound(ctx, requireUser(req), parse(soundCreateSchema, req.body));
      reply.status(201);
      return { sound };
    });
    app.patch('/api/sounds/:id', async (req) => ({ sound: await updateSound(ctx, requireUser(req), parse(idParam, req.params).id, parse(soundUpdateSchema, req.body)) }));
    app.delete('/api/sounds/:id', async (req) => deleteSound(ctx, requireUser(req), parse(idParam, req.params).id));
    app.post('/api/sounds/:id/trigger', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) =>
      triggerSoundAsStaff(ctx, requireUser(req), parse(idParam, req.params).id),
    );
  };
