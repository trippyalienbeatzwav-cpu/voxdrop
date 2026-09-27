import { createHmac, randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { AppError } from '../../lib/errors.js';
import { safeEqual } from '../../lib/crypto.js';

export interface CheckoutRequest {
  paymentId: string;
  amountCents: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
}

/** Provider-neutral view of a checkout, fetched from the provider for verification. */
export interface VerifiedCheckout {
  sessionId: string;
  paymentId: string | null;
  providerPaymentId: string | null;
  status: 'paid' | 'unpaid' | 'expired';
  amountCents: number;
  currency: string;
}

export type PaymentEvent =
  | { id: string; kind: 'checkout.completed' | 'checkout.expired' | 'checkout.failed'; sessionId: string }
  | { id: string; kind: 'refund.succeeded'; providerPaymentId: string; refundId: string; amountCents: number }
  | { id: string; kind: 'ignored'; type: string };

/**
 * Money never touches the points ledger. PaymentService only moves money via a
 * provider-hosted checkout (no card data ever reaches our servers) and reports
 * verified outcomes back.
 */
export interface PaymentService {
  readonly name: 'stripe' | 'mock';
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Fetches the authoritative session state from the provider. */
  retrieveCheckout(sessionId: string): Promise<VerifiedCheckout>;
  /** Verifies the webhook signature and normalises the event. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent;
  refund(providerPaymentId: string, amountCents: number): Promise<{ refundId: string; status: 'succeeded' | 'pending' | 'failed' }>;
}

/**
 * Stripe Checkout implementation.
 * REQUIRES real PAYMENT_SECRET_KEY + PAYMENT_WEBHOOK_SECRET; not exercised by
 * the automated tests (they use MockPaymentService through the same flow).
 */
export class StripePaymentService implements PaymentService {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;
  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const s = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: req.currency, unit_amount: req.amountCents, product_data: { name: req.description } } }],
        client_reference_id: req.paymentId,
        metadata: { payment_id: req.paymentId },
        payment_intent_data: { metadata: { payment_id: req.paymentId } },
        success_url: req.successUrl,
        cancel_url: req.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      },
      { idempotencyKey: `checkout:${req.paymentId}` },
    );
    if (!s.url) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Stripe did not return a checkout URL');
    return { sessionId: s.id, url: s.url };
  }

  async retrieveCheckout(sessionId: string): Promise<VerifiedCheckout> {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId);
    return {
      sessionId: s.id,
      paymentId: s.metadata?.payment_id ?? s.client_reference_id ?? null,
      providerPaymentId: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null),
      status: s.payment_status === 'paid' ? 'paid' : s.status === 'expired' ? 'expired' : 'unpaid',
      amountCents: s.amount_total ?? 0,
      currency: s.currency ?? '',
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    const sig = headers['stripe-signature'];
    let evt: Stripe.Event;
    try {
      evt = this.stripe.webhooks.constructEvent(rawBody, Array.isArray(sig) ? sig[0]! : (sig ?? ''), this.webhookSecret);
    } catch {
      throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid payment webhook signature');
    }
    switch (evt.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return { id: evt.id, kind: 'checkout.completed', sessionId: (evt.data.object as Stripe.Checkout.Session).id };
      case 'checkout.session.expired':
        return { id: evt.id, kind: 'checkout.expired', sessionId: (evt.data.object as Stripe.Checkout.Session).id };
      case 'checkout.session.async_payment_failed':
        return { id: evt.id, kind: 'checkout.failed', sessionId: (evt.data.object as Stripe.Checkout.Session).id };
      case 'refund.updated':
      case 'refund.created': {
        const r = evt.data.object as Stripe.Refund;
        if (r.status !== 'succeeded') return { id: evt.id, kind: 'ignored', type: evt.type };
        const pi = typeof r.payment_intent === 'string' ? r.payment_intent : (r.payment_intent?.id ?? '');
        return { id: evt.id, kind: 'refund.succeeded', providerPaymentId: pi, refundId: r.id, amountCents: r.amount };
      }
      default:
        return { id: evt.id, kind: 'ignored', type: evt.type };
    }
  }

  async refund(providerPaymentId: string, amountCents: number) {
    const r = await this.stripe.refunds.create({ payment_intent: providerPaymentId, amount: amountCents }, { idempotencyKey: `refund:${providerPaymentId}:${amountCents}` });
    return { refundId: r.id, status: r.status === 'succeeded' ? ('succeeded' as const) : r.status === 'failed' ? ('failed' as const) : ('pending' as const) };
  }
}

/**
 * ███ DEVELOPMENT ONLY ███
 * MockPaymentService simulates a hosted checkout: the "checkout page" is a
 * dev-only screen in our own app with Pay / Decline buttons. Outcomes are
 * delivered as HMAC-signed webhooks through the SAME verification and
 * fulfilment code path as Stripe. Refused in production by config.ts.
 */
export class MockPaymentService implements PaymentService {
  readonly name = 'mock' as const;
  private readonly sessions = new Map<string, VerifiedCheckout & { description: string; successUrl: string; cancelUrl: string }>();

  constructor(
    private readonly appUrl: string,
    private readonly secret: string,
  ) {}

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const sessionId = `mock_cs_${randomUUID().replace(/-/g, '')}`;
    this.sessions.set(sessionId, {
      sessionId,
      paymentId: req.paymentId,
      providerPaymentId: null,
      status: 'unpaid',
      amountCents: req.amountCents,
      currency: req.currency,
      description: req.description,
      successUrl: req.successUrl,
      cancelUrl: req.cancelUrl,
    });
    return { sessionId, url: new URL(`/dev/mock-checkout/${sessionId}`, this.appUrl).toString() };
  }

  /** Public details for the dev checkout screen. */
  describe(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return { sessionId, amountCents: s.amountCents, currency: s.currency, description: s.description, status: s.status, successUrl: s.successUrl, cancelUrl: s.cancelUrl };
  }

  /** Dev screen action: mark paid/declined and return a signed webhook to deliver. */
  simulate(sessionId: string, outcome: 'paid' | 'declined') {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AppError(404, 'NOT_FOUND', 'Checkout session not found');
    if (s.status !== 'unpaid') throw new AppError(409, 'CONFLICT', 'Checkout already finished');
    if (outcome === 'paid') {
      s.status = 'paid';
      s.providerPaymentId = `mock_pi_${randomUUID().replace(/-/g, '')}`;
    } else {
      s.status = 'expired';
    }
    return this.signedWebhook({ id: `mock_evt_${randomUUID()}`, type: outcome === 'paid' ? 'checkout.completed' : 'checkout.failed', sessionId });
  }

  signedWebhook(event: Record<string, unknown>) {
    const body = Buffer.from(JSON.stringify(event));
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', this.secret).update(`${t}.`).update(body).digest('hex');
    return { body, headers: { 'content-type': 'application/json', 'x-mock-signature': `t=${t},v1=${sig}` } };
  }

  async retrieveCheckout(sessionId: string): Promise<VerifiedCheckout> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AppError(404, 'NOT_FOUND', 'Checkout session not found');
    const { sessionId: id, paymentId, providerPaymentId, status, amountCents, currency } = s;
    return { sessionId: id, paymentId, providerPaymentId, status, amountCents, currency };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent {
    const raw = headers['x-mock-signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
    if (!m) throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid payment webhook signature');
    const expected = createHmac('sha256', this.secret).update(`${m[1]}.`).update(rawBody).digest('hex');
    if (!safeEqual(expected, m[2]!) || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) {
      throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid payment webhook signature');
    }
    const e = JSON.parse(rawBody.toString('utf8')) as { id: string; type: string; sessionId?: string; providerPaymentId?: string; refundId?: string; amountCents?: number };
    if (e.type === 'checkout.completed' || e.type === 'checkout.failed' || e.type === 'checkout.expired') return { id: e.id, kind: e.type, sessionId: e.sessionId! };
    if (e.type === 'refund.succeeded') return { id: e.id, kind: 'refund.succeeded', providerPaymentId: e.providerPaymentId!, refundId: e.refundId!, amountCents: e.amountCents! };
    return { id: e.id, kind: 'ignored', type: e.type };
  }

  async refund(providerPaymentId: string) {
    return { refundId: `mock_re_${providerPaymentId.slice(-12)}_${Date.now()}`, status: 'succeeded' as const };
  }
}
