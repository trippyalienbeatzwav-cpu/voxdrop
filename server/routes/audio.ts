import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { canStreamAudio, publicAudio, uploadAudio, type AudioFileRow } from '../services/audio.js';
import { idParam, parse, requireUser } from '../http.js';

export const audioRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/api/audio/upload',
      { config: { rateLimit: { max: 12, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } },
      async (req, reply) => {
        const user = requireUser(req);
        if (!req.isMultipart()) throw Errors.unsupportedMedia('Expected multipart/form-data');
        const file = await req.file();
        if (!file) throw Errors.validation('No file uploaded');
        const field = (name: string) => {
          const f = file.fields[name];
          const v = Array.isArray(f) ? f[0] : f;
          return v && 'value' in v ? String(v.value) : undefined;
        };
        const meta = parse(
          z.object({ streamerId: z.string().uuid(), purpose: z.enum(['MESSAGE', 'SOUND', 'DONATION']).default('MESSAGE') }),
          { streamerId: field('streamerId'), purpose: field('purpose') },
        );
        let buffer: Buffer;
        try {
          buffer = await file.toBuffer();
        } catch (err) {
          if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'FILE_TOO_LARGE', 'File is too large');
          throw err;
        }
        const row = await uploadAudio(ctx, user, { buffer, filename: file.filename, mimeType: file.mimetype, streamerId: meta.streamerId, purpose: meta.purpose });
        reply.status(201);
        return { audio: publicAudio(row) };
      },
    );

    /**
     * Authorized audio streaming (private storage is never exposed directly).
     * Supports single byte ranges so browsers can seek.
     */
    app.get('/api/audio/:id/stream', async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const { k } = parse(z.object({ k: z.string().max(100).optional() }), req.query);
      const audio = await one<AudioFileRow>(ctx.db, 'SELECT * FROM audio_files WHERE id = $1', [id]);
      if (!audio || !(await canStreamAudio(ctx, audio, { user: req.user, overlayKey: k }))) throw Errors.notFound('Audio');
      const body = await ctx.storage.get(audio.storage_key);
      if (!body) throw Errors.notFound('Audio');

      reply.header('Content-Type', audio.mime_type);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', audio.purpose === 'SOUND' ? 'public, max-age=3600' : 'private, max-age=600');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Disposition', 'inline');
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : body.length - 1;
        start = Math.max(0, start);
        end = Math.min(end, body.length - 1);
        if (start > end) {
          reply.header('Content-Range', `bytes */${body.length}`);
          return reply.status(416).send();
        }
        reply.status(206).header('Content-Range', `bytes ${start}-${end}/${body.length}`);
        return reply.send(body.subarray(start, end + 1));
      }
      return reply.send(body);
    });
  };
