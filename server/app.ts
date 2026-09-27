import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './context.js';
import { AppError } from './lib/errors.js';
import { safeEqual } from './lib/crypto.js';
import { resolveSession, SESSION_COOKIE } from './auth/sessions.js';
import { PLATFORM_MAX_BYTES } from './services/audio.js';
import { schedulePositions } from './services/queue.js';
import { authRoutes } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';
import { messageRoutes } from './routes/messages.js';
import { audioRoutes } from './routes/audio.js';
import { soundRoutes } from './routes/sounds.js';
import { pointsRoutes } from './routes/points.js';
import { donationRoutes } from './routes/donations.js';
import { channelRoutes } from './routes/channel.js';
import { notificationRoutes } from './routes/notifications.js';
import { realtimeRoutes } from './routes/realtime.js';
import { webhookRoutes } from './routes/webhooks.js';
import { adminRoutes } from './routes/admin.js';
import { devRoutes } from './routes/dev.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Routes that authenticate by signature or overlay key instead of a session — exempt from CSRF. */
const CSRF_EXEMPT = [/^\/api\/webhooks\//, /^\/api\/overlay\//];
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.isTest ? false : { level: ctx.config.isProd ? 'info' : 'warn' },
    trustProxy: ctx.config.isProd,
    bodyLimit: 1024 * 1024,
  });
  if (!ctx.config.isTest) ctx.log = app.log;

  // Keep the raw body: webhook signatures are computed over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (!body.length) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      done(new AppError(400, 'BAD_JSON', 'Request body is not valid JSON'), undefined);
    }
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://id.kick.com', 'https://checkout.stripe.com'],
        upgradeInsecureRequests: ctx.config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: ctx.config.isProd,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    // Webhook senders retry on 429; they are authenticated by signature instead.
    allowList: (req) => req.url.startsWith('/api/webhooks/') || req.url.startsWith('/api/overlay/'),
    errorResponseBuilder: (_req, c) => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: `Too many requests — slow down and retry in ${Math.ceil(c.ttl / 1000)}s` } }),
  });
  await app.register(multipart, { limits: { fileSize: PLATFORM_MAX_BYTES, files: 1, fields: 10, fieldSize: 1024, parts: 12 } });

  app.decorateRequest('user', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const s = await resolveSession(ctx.db, token);
    if (s) {
      req.user = s.user;
      req.session = s.session;
    }
  });

  // CSRF: every state-changing request from a browser session must echo the
  // per-session token in a header (not readable cross-origin) and, if the
  // browser sent an Origin, it must be ours.
  app.addHook('preHandler', async (req) => {
    if (!UNSAFE.has(req.method)) return;
    const url = req.url.split('?')[0]!;
    if (CSRF_EXEMPT.some((r) => r.test(url))) return;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(ctx.config.APP_URL).origin && !(ctx.config.isDev && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
      throw new AppError(403, 'CSRF_FAILED', 'Cross-site request blocked');
    }
    if (!req.session) return; // unauthenticated → the route itself will 401
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !safeEqual(header, req.session.csrf_token)) throw new AppError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token — refresh the page');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.code === 'COOLDOWN_ACTIVE' && err.details?.retryAfterSeconds) reply.header('Retry-After', String(err.details.retryAfterSeconds));
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: e.message ?? 'Too many requests' } });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_FILES_LIMIT' || e.statusCode === 413) {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'File is too large' } });
    }
    if (e.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return reply.status(415).send({ error: { code: 'UNSUPPORTED_MEDIA', message: 'Expected multipart/form-data' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: e.message ?? 'Bad request' } });
    }
    req.log.error({ err }, 'unhandled error');
    if (ctx.config.isTest) console.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
  });

  // Any queue change → push fresh positions/ETAs to the viewers waiting in that queue.
  const unsubPositions = ctx.bus.subscribe('*', (e) => {
    if (e.type === 'queue.updated') {
      const sid = (e.data as { streamerId?: string }).streamerId;
      if (sid) schedulePositions(ctx, sid);
    }
  });
  app.addHook('onClose', async () => unsubPositions());

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(authRoutes(ctx));
  await app.register(publicRoutes(ctx));
  await app.register(messageRoutes(ctx));
  await app.register(audioRoutes(ctx));
  await app.register(soundRoutes(ctx));
  await app.register(pointsRoutes(ctx));
  await app.register(donationRoutes(ctx));
  await app.register(channelRoutes(ctx));
  await app.register(notificationRoutes(ctx));
  await app.register(realtimeRoutes(ctx));
  await app.register(webhookRoutes(ctx));
  await app.register(adminRoutes(ctx));
  if (!ctx.config.isProd && (ctx.mockKick || ctx.mockPayments)) await app.register(devRoutes(ctx));

  // Production: serve the built SPA from dist/web with history-API fallback.
  const webRoot = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((p) => existsSync(path.join(p, 'index.html')));
  if (webRoot && !ctx.config.isTest) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, maxAge: '1h' });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.method !== 'GET' || !webRoot || ctx.config.isTest) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    return reply.type('text/html').sendFile('index.html');
  });

  return app;
}
