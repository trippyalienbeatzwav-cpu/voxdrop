import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../lib/errors.js';
import { handleKickEvent } from '../services/rewards.js';
import { handlePaymentEvent } from '../services/payments.js';

export const webhookRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    /**
     * Kick event webhooks. Signature is verified over the raw bytes BEFORE any
     * processing. Duplicate deliveries return 200 so Kick stops retrying;
     * processing failures return 500 so Kick retries (the FAILED row is
     * re-claimed atomically on redelivery).
     */
    app.post('/api/webhooks/kick', async (req, reply) => {
      if (!req.rawBody) throw new AppError(400, 'WEBHOOK_INVALID', 'Expected a JSON body');
      const evt = await ctx.kickWebhooks.verify(req.headers, req.rawBody);
      const r = await handleKickEvent(ctx, evt);
      if (r.status === 'failed') return reply.status(500).send({ error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Event stored; processing failed' } });
      return { status: r.status };
    });

    /** Payment provider webhooks (Stripe, or the dev-only mock provider). */
    app.post('/api/webhooks/payments', async (req, reply) => {
      if (!req.rawBody) throw new AppError(400, 'WEBHOOK_INVALID', 'Expected a JSON body');
      const evt = ctx.payments.parseWebhook(req.rawBody, req.headers);
      const r = await handlePaymentEvent(ctx, evt);
      if (r.status === 'failed') return reply.status(500).send({ error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Event stored; processing failed' } });
      return { status: r.status };
    });
  };
