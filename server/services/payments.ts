import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { cleanText, findBlockedWord } from '../lib/text.js';
import { Outbox, Topic } from '../events/bus.js';
import { applyPoints } from './points.js';
import { notify } from './notifications.js';
import { audit } from './audit.js';
import { activeRestriction } from './moderation.js';
import { getSettings, requireChannel } from './streamers.js';
import { enqueue, tryAdvance } from './queue.js';
import { deliverAlerts } from './alerts.js';
import type { PaymentEvent } from '../integrations/payments/PaymentService.js';
import type { SessionUser, StreamerRow } from './types.js';
import type { AudioFileRow } from './audio.js';

export const donationSchema = z.object({
  streamerId: z.string().uuid(),
  amountCents: z.number().int().positive().max(10_000_000),
  message: z.string().max(1000).optional().default(''),
  audioFileId: z.string().uuid().optional(),
  anonymous: z.boolean().optional().default(false),
});

interface PaymentRow {
  id: string;
  user_id: string;
  provider: 'stripe' | 'mock';
  provider_session_id: string | null;
  provider_payment_id: string | null;
  purpose: 'DONATION' | 'POINTS_PURCHASE';
  amount_cents: number;
  currency: string;
  status: 'CREATED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
  points_package_id: string | null;
  points_amount: number | null;
}

interface DonationRow {
  id: string;
  streamer_id: string;
  donor_id: string;
  payment_id: string;
  amount_cents: number;
  currency: string;
  message: string;
  audio_file_id: string | null;
  message_id: string | null;
  is_anonymous: boolean;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'CANCELLED';
}

export const formatMoney = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

/** Starts a donation: creates PENDING records and a provider-hosted checkout. */
export async function createDonation(ctx: AppContext, user: SessionUser, input: z.infer<typeof donationSchema>) {
  if (user.status !== 'ACTIVE') throw Errors.suspended();
  const streamer = await one<StreamerRow>(ctx.db, 'SELECT * FROM streamers WHERE id = $1 AND deleted_at IS NULL', [input.streamerId]);
  if (!streamer || streamer.status !== 'ACTIVE') throw Errors.notFound('Streamer');
  if (streamer.user_id === user.id) throw Errors.badRequest('You cannot donate to your own channel');
  const s = await getSettings(ctx.db, streamer.id);
  if (!s.donations_enabled) throw Errors.featureDisabled('This streamer is not accepting donations');
  if (input.amountCents < s.donation_min_cents || input.amountCents > s.donation_max_cents) {
    throw Errors.validation(`Donations must be between ${formatMoney(s.donation_min_cents, ctx.config.PAYMENT_CURRENCY)} and ${formatMoney(s.donation_max_cents, ctx.config.PAYMENT_CURRENCY)}`, {
      minCents: s.donation_min_cents,
      maxCents: s.donation_max_cents,
    });
  }
  const r = await activeRestriction(ctx.db, streamer.id, user.id);
  if (r?.kind === 'BAN') throw Errors.banned('You are banned from this channel');

  const message = cleanText(input.message, 300);
  if (message && s.auto_reject_blocked_words && findBlockedWord(message, s.blocked_words)) {
    throw new AppError(422, 'MESSAGE_BLOCKED', 'Your message contains a word this channel does not allow');
  }
  if (input.audioFileId) {
    if (!s.donation_voice_enabled) throw Errors.featureDisabled('Voice donations are turned off on this channel');
    const a = await one<AudioFileRow>(ctx.db, 'SELECT * FROM audio_files WHERE id = $1', [input.audioFileId]);
    if (!a || a.deleted_at || a.owner_id !== user.id || a.attached_at || !['DONATION', 'MESSAGE'].includes(a.purpose)) throw Errors.notFound('Audio file');
    if (a.duration_ms > s.max_audio_seconds * 1000 + 250) throw Errors.audioTooLong(a.duration_ms, s.max_audio_seconds);
  }

  const currency = ctx.config.PAYMENT_CURRENCY;
  const { payment, donation } = await ctx.db.tx(async (q) => {
    const payment = await one<PaymentRow>(
      q,
      `INSERT INTO payments (user_id, provider, purpose, amount_cents, currency) VALUES ($1,$2,'DONATION',$3,$4) RETURNING *`,
      [user.id, ctx.payments.name, input.amountCents, currency],
    );
    const donation = await one<DonationRow>(
      q,
      `INSERT INTO donations (streamer_id, donor_id, payment_id, amount_cents, currency, message, audio_file_id, is_anonymous)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [streamer.id, user.id, payment!.id, input.amountCents, currency, message, input.audioFileId ?? null, input.anonymous],
    );
    if (input.audioFileId) await q.query('UPDATE audio_files SET attached_at = now(), streamer_id = $2 WHERE id = $1', [input.audioFileId, streamer.id]);
    return { payment: payment!, donation: donation! };
  });

  const checkout = await startCheckout(ctx, payment, `Donation to ${streamer.display_name}`, `/donations/result?donation=${donation.id}`);
  ctx.bus.publish(Topic.channel(streamer.id), 'donation.created', { donationId: donation.id, amountCents: donation.amount_cents, status: 'PENDING' });
  return { donationId: donation.id, paymentId: payment.id, checkoutUrl: checkout.url };
}

/** Starts a points purchase for a platform points package (money → points, recorded in both ledgers). */
export async function purchasePoints(ctx: AppContext, user: SessionUser, packageId: string) {
  if (user.status !== 'ACTIVE') throw Errors.suspended();
  const pkg = await one<{ id: string; name: string; points: number; price_cents: number; currency: string }>(
    ctx.db,
    'SELECT * FROM points_packages WHERE id = $1 AND is_active',
    [packageId],
  );
  if (!pkg) throw Errors.notFound('Points package');
  const payment = await one<PaymentRow>(
    ctx.db,
    `INSERT INTO payments (user_id, provider, purpose, amount_cents, currency, points_package_id, points_amount)
     VALUES ($1,$2,'POINTS_PURCHASE',$3,$4,$5,$6) RETURNING *`,
    [user.id, ctx.payments.name, pkg.price_cents, pkg.currency, pkg.id, pkg.points],
  );
  const checkout = await startCheckout(ctx, payment!, `${pkg.points.toLocaleString('en-US')} VoxDrop points`, `/points?purchase=${payment!.id}`);
  return { paymentId: payment!.id, checkoutUrl: checkout.url };
}

async function startCheckout(ctx: AppContext, payment: PaymentRow, description: string, returnPath: string) {
  try {
    const base = ctx.config.APP_URL;
    const sep = returnPath.includes('?') ? '&' : '?';
    const session = await ctx.payments.createCheckout({
      paymentId: payment.id,
      amountCents: payment.amount_cents,
      currency: payment.currency,
      description,
      successUrl: `${base}${returnPath}${sep}status=success`,
      cancelUrl: `${base}${returnPath}${sep}status=cancelled`,
    });
    await ctx.db.query('UPDATE payments SET provider_session_id = $2, updated_at = now() WHERE id = $1', [payment.id, session.sessionId]);
    return session;
  } catch (err) {
    await ctx.db.query(`UPDATE payments SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1`, [payment.id, 'checkout_create_failed']);
    await ctx.db.query(`UPDATE donations SET status = 'FAILED' WHERE payment_id = $1`, [payment.id]);
    if (err instanceof AppError) throw err;
    throw Errors.payment('The payment provider is unavailable — please try again');
  }
}

/**
 * Processes a verified payment webhook. Idempotent via webhook_events and the
 * CREATED→SUCCEEDED state guard; the checkout is re-fetched from the provider
 * and amount/currency/payment id are cross-checked before anything is fulfilled.
 */
export async function handlePaymentEvent(ctx: AppContext, evt: PaymentEvent) {
  const provider = ctx.payments.name;
  const row = await one<{ id: string }>(
    ctx.db,
    `INSERT INTO webhook_events (provider, event_id, event_type, payload, attempts) VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [provider, evt.id, evt.kind, JSON.stringify(evt)],
  );
  if (!row) {
    const retry = await one<{ id: string }>(
      ctx.db,
      `UPDATE webhook_events SET status = 'RECEIVED', attempts = attempts + 1 WHERE provider = $1 AND event_id = $2 AND status = 'FAILED' RETURNING id`,
      [provider, evt.id],
    );
    if (!retry) return { status: 'duplicate' as const };
    return runPaymentEvent(ctx, retry.id, evt);
  }
  return runPaymentEvent(ctx, row.id, evt);
}

async function runPaymentEvent(ctx: AppContext, webhookId: string, evt: PaymentEvent) {
  const outbox = new Outbox();
  let queuedStreamer: string | null = null;
  try {
    let status: 'PROCESSED' | 'IGNORED' = 'IGNORED';
    if (evt.kind === 'checkout.completed') {
      const verified = await ctx.payments.retrieveCheckout(evt.sessionId);
      queuedStreamer = await ctx.db.tx(async (q) => {
        const p = await one<PaymentRow>(q, 'SELECT * FROM payments WHERE provider_session_id = $1 FOR UPDATE', [evt.sessionId]);
        if (!p) throw new Error(`Unknown checkout session ${evt.sessionId}`);
        if (verified.status !== 'paid') throw new Error('Provider reports the checkout is not paid');
        if (verified.paymentId !== p.id || verified.amountCents !== p.amount_cents || verified.currency.toLowerCase() !== p.currency.toLowerCase()) {
          throw new Error('Checkout does not match the payment record (amount/currency/id mismatch)');
        }
        if (p.status !== 'CREATED') return null; // already fulfilled
        await q.query(`UPDATE payments SET status = 'SUCCEEDED', provider_payment_id = $2, updated_at = now() WHERE id = $1`, [p.id, verified.providerPaymentId]);
        if (p.purpose === 'POINTS_PURCHASE') {
          await applyPoints(
            q,
            { userId: p.user_id, type: 'POINTS_PURCHASED', amount: p.points_amount!, description: `Purchased ${p.points_amount!.toLocaleString('en-US')} points`, referenceType: 'payment', referenceId: p.id, idempotencyKey: `payment:${p.id}` },
            outbox,
          );
          await notify(q, outbox, p.user_id, 'points.received', `+${p.points_amount!.toLocaleString('en-US')} points added`, `Payment of ${formatMoney(p.amount_cents, p.currency)} confirmed.`, { paymentId: p.id });
          await audit(q, { actorUserId: p.user_id, action: 'points.purchased', entityType: 'payment', entityId: p.id, metadata: { points: p.points_amount, amountCents: p.amount_cents } });
          return null;
        }
        return completeDonation(q, outbox, p);
      });
      status = 'PROCESSED';
    } else if (evt.kind === 'checkout.expired' || evt.kind === 'checkout.failed') {
      await ctx.db.tx(async (q) => {
        const p = await one<PaymentRow>(q, `SELECT * FROM payments WHERE provider_session_id = $1 FOR UPDATE`, [evt.sessionId]);
        if (!p || p.status !== 'CREATED') return;
        await q.query(`UPDATE payments SET status = $2, failure_reason = $3, updated_at = now() WHERE id = $1`, [p.id, evt.kind === 'checkout.expired' ? 'EXPIRED' : 'FAILED', evt.kind]);
        const d = await one<DonationRow>(q, `UPDATE donations SET status = 'FAILED' WHERE payment_id = $1 RETURNING *`, [p.id]);
        if (d?.audio_file_id) await q.query('UPDATE audio_files SET attached_at = NULL WHERE id = $1', [d.audio_file_id]);
        outbox.push(Topic.user(p.user_id), 'donation.completed', { paymentId: p.id, status: 'FAILED' });
      });
      status = 'PROCESSED';
    } else if (evt.kind === 'refund.succeeded') {
      await ctx.db.tx(async (q) => {
        const p = await one<PaymentRow>(q, 'SELECT * FROM payments WHERE provider_payment_id = $1 FOR UPDATE', [evt.providerPaymentId]);
        if (!p) return;
        await q.query(
          `INSERT INTO refunds (payment_id, amount_cents, provider_refund_id, reason, status) VALUES ($1,$2,$3,'provider webhook','SUCCEEDED')
           ON CONFLICT (provider_refund_id) DO UPDATE SET status = 'SUCCEEDED'`,
          [p.id, evt.amountCents, evt.refundId],
        );
        await markRefunded(q, outbox, p);
      });
      status = 'PROCESSED';
    }
    await ctx.db.query(`UPDATE webhook_events SET status = $2, processed_at = now() WHERE id = $1`, [webhookId, status]);
    outbox.flush(ctx.bus);
    await deliverAlerts(ctx, outbox.alerts);
    if (queuedStreamer) await tryAdvance(ctx, queuedStreamer);
    return { status: status === 'PROCESSED' ? ('processed' as const) : ('ignored' as const) };
  } catch (err) {
    await ctx.db.query(`UPDATE webhook_events SET status = 'FAILED', error = $2 WHERE id = $1`, [webhookId, String((err as Error).message).slice(0, 1000)]);
    ctx.log.error({ err, webhookId }, 'payment webhook failed');
    return { status: 'failed' as const, error: (err as Error).message };
  }
}

/** Marks the donation complete and turns its message/voice into a queue item. */
async function completeDonation(q: Db, outbox: Outbox, p: PaymentRow): Promise<string | null> {
  const d = await one<DonationRow>(q, `UPDATE donations SET status = 'COMPLETED', completed_at = now() WHERE payment_id = $1 AND status = 'PENDING' RETURNING *`, [p.id]);
  if (!d) return null;
  const streamer = await one<StreamerRow>(q, 'SELECT * FROM streamers WHERE id = $1', [d.streamer_id]);
  const s = await getSettings(q, d.streamer_id);
  const amount = formatMoney(d.amount_cents, d.currency);
  let queued = false;

  if (d.message || d.audio_file_id) {
    const blocked = findBlockedWord(d.message, s.blocked_words);
    const status = s.approval_mode === 'AUTO' && !blocked ? 'APPROVED' : 'PENDING';
    const m = await one<{ id: string; streamer_id: string; sender_id: string; is_priority: boolean }>(
      q,
      `INSERT INTO messages (streamer_id, sender_id, type, text_content, audio_file_id, donation_id, points_spent, is_priority, status, flagged, flag_reason)
       VALUES ($1,$2,$3,$4,$5,$6,0,true,$7,$8,$9) RETURNING id, streamer_id, sender_id, is_priority`,
      [d.streamer_id, d.donor_id, d.audio_file_id ? 'VOICE' : 'TEXT', d.message, d.audio_file_id, d.id, status, !!blocked, blocked ? 'Blocked word (manual review)' : null],
    );
    await q.query('UPDATE donations SET message_id = $2 WHERE id = $1', [d.id, m!.id]);
    outbox.push(Topic.channel(d.streamer_id), 'message.created', { messageId: m!.id, donationId: d.id });
    if (status === 'APPROVED' && s.auto_queue_approved) {
      await enqueue(q, outbox, m!);
      queued = true;
    }
  }
  await notify(q, outbox, d.donor_id, 'donation.completed', `Your ${amount} donation went through`, `Thank you for supporting ${streamer!.display_name}!`, { donationId: d.id });
  await notify(q, outbox, streamer!.user_id, 'donation.received', `New donation: ${amount}`, d.message.slice(0, 120), { donationId: d.id });
  await audit(q, { actorUserId: d.donor_id, streamerId: d.streamer_id, action: 'donation.completed', entityType: 'donation', entityId: d.id, metadata: { amountCents: d.amount_cents, currency: d.currency } });
  const donor = await one<{ username: string; display_name: string; avatar_url: string | null }>(q, 'SELECT username, display_name, avatar_url FROM users WHERE id = $1', [d.donor_id]);
  const who = d.is_anonymous ? 'Anonymous' : donor!.display_name;
  outbox.push([Topic.channel(d.streamer_id), Topic.user(d.donor_id)], 'donation.completed', { donationId: d.id, amountCents: d.amount_cents, currency: d.currency, donor: who, status: 'COMPLETED' });
  // Reached only from a signature-verified provider webhook after server-side re-verification of the checkout.
  outbox.alerts.push({
    streamerId: d.streamer_id,
    kind: 'donation',
    sourceType: 'donation',
    sourceId: d.id,
    viewerName: who,
    avatarUrl: d.is_anonymous ? null : donor!.avatar_url,
    amountCents: d.amount_cents,
    currency: d.currency,
    message: d.audio_file_id ? '' : d.message,
  });
  return queued ? d.streamer_id : null;
}

async function markRefunded(q: Db, outbox: Outbox, p: PaymentRow) {
  if (p.status === 'REFUNDED') return;
  await q.query(`UPDATE payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [p.id]);
  const d = await one<DonationRow>(q, `UPDATE donations SET status = 'REFUNDED', refunded_at = now() WHERE payment_id = $1 RETURNING *`, [p.id]);
  if (d) {
    await notify(q, outbox, d.donor_id, 'donation.refunded', `Your ${formatMoney(d.amount_cents, d.currency)} donation was refunded`, '', { donationId: d.id });
    outbox.push([Topic.channel(d.streamer_id), Topic.user(d.donor_id)], 'donation.refunded', { donationId: d.id });
  } else {
    await notify(q, outbox, p.user_id, 'refund', `Refund of ${formatMoney(p.amount_cents, p.currency)} issued`, '', { paymentId: p.id });
  }
}

/** Refunds a completed donation through the provider (channel owner or admin). */
export async function refundDonation(ctx: AppContext, actor: SessionUser, donationId: string, reason: string, ipHash: string | null) {
  const d = await one<DonationRow>(ctx.db, 'SELECT * FROM donations WHERE id = $1', [donationId]);
  if (!d) throw Errors.notFound('Donation');
  await requireChannel(ctx.db, actor, d.streamer_id, 'manage');
  if (d.status !== 'COMPLETED') throw Errors.conflict('Only completed donations can be refunded', 'INVALID_STATE');
  const p = await one<PaymentRow>(ctx.db, 'SELECT * FROM payments WHERE id = $1', [d.payment_id]);
  if (!p?.provider_payment_id) throw Errors.conflict('Payment has no provider reference', 'INVALID_STATE');

  const result = await ctx.payments.refund(p.provider_payment_id, p.amount_cents);
  const outbox = new Outbox();
  await ctx.db.tx(async (q) => {
    await q.query(
      `INSERT INTO refunds (payment_id, amount_cents, provider_refund_id, reason, status, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider_refund_id) DO NOTHING`,
      [p.id, p.amount_cents, result.refundId, cleanText(reason, 200), result.status === 'succeeded' ? 'SUCCEEDED' : result.status === 'failed' ? 'FAILED' : 'PENDING', actor.id],
    );
    if (result.status === 'succeeded') await markRefunded(q, outbox, { ...p, status: 'SUCCEEDED' });
    await audit(q, { actorUserId: actor.id, streamerId: d.streamer_id, action: 'donation.refund_requested', entityType: 'donation', entityId: d.id, metadata: { status: result.status, reason }, ipHash });
  });
  outbox.flush(ctx.bus);
  if (result.status === 'failed') throw Errors.payment('The payment provider declined the refund');
  return { status: result.status };
}

export async function listDonationsForChannel(db: Db, streamerId: string, status: string | undefined, limit: number, cursorSql: string, params: unknown[]) {
  return many(
    db,
    `SELECT d.id, d.amount_cents, d.currency, d.message, d.status, d.is_anonymous, d.created_at, d.completed_at, d.refunded_at, d.audio_file_id,
            u.id AS donor_id, u.username AS donor_username, u.display_name AS donor_display_name, u.avatar_url AS donor_avatar
       FROM donations d JOIN users u ON u.id = d.donor_id
      WHERE d.streamer_id = $1 ${status ? `AND d.status = $2` : ''} ${cursorSql}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit + 1}`,
    params,
  );
}
