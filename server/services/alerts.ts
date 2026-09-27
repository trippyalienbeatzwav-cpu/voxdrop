import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import { MAX_SPOKEN_TEXT, renderAnnouncement, sanitizeSpokenName, sanitizeTemplate } from '../lib/speech.js';
import { Topic } from '../events/bus.js';
import { speakCached } from './announcements.js';
import { formatMoney } from './payments.js';
import { getSettings } from './streamers.js';
import { ALERT_KINDS, type AlertIntent, type AlertKind } from './alertTypes.js';
import type { SessionUser } from './types.js';

export { ALERT_KINDS, type AlertIntent, type AlertKind };

export const DEFAULT_TEMPLATES: Record<AlertKind, string> = {
  subscription: '{viewerName} just subscribed!',
  gift_sub: '{viewerName} gifted {giftCount} subs!',
  donation: '{viewerName} donated {amount}!',
};

export interface AlertSettings {
  kind: AlertKind;
  enabled: boolean;
  template: string;
  custom_message: string;
  show_avatar: boolean;
  show_message: boolean;
  animation: 'slide' | 'pop' | 'fade' | 'bounce';
  position: 'top-left' | 'top' | 'top-right' | 'center' | 'bottom-left' | 'bottom' | 'bottom-right';
  duration_ms: number;
  sound_id: string | null;
  volume: number;
  tts_enabled: boolean;
  tts_read_message: boolean;
  min_amount_cents: number;
  accent_color: string | null;
}

export async function ensureAlertSettings(db: Db, streamerId: string) {
  for (const kind of ALERT_KINDS) {
    await db.query(`INSERT INTO streamer_alert_settings (streamer_id, kind, template, accent_color) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
      streamerId,
      kind,
      DEFAULT_TEMPLATES[kind],
      kind === 'donation' ? '#FF3D8B' : kind === 'gift_sub' ? '#B18CFF' : '#C6FF3D',
    ]);
  }
}

export async function getAlertSettings(db: Db, streamerId: string): Promise<Record<AlertKind, AlertSettings>> {
  let rows = await many<AlertSettings>(db, 'SELECT * FROM streamer_alert_settings WHERE streamer_id = $1', [streamerId]);
  if (rows.length < ALERT_KINDS.length) {
    await ensureAlertSettings(db, streamerId);
    rows = await many<AlertSettings>(db, 'SELECT * FROM streamer_alert_settings WHERE streamer_id = $1', [streamerId]);
  }
  return Object.fromEntries(rows.map((r) => [r.kind, r])) as Record<AlertKind, AlertSettings>;
}

export const alertSettingsSchema = z
  .object({
    enabled: z.boolean(),
    template: z.string().trim().min(1).max(120),
    custom_message: z.string().max(160),
    show_avatar: z.boolean(),
    show_message: z.boolean(),
    animation: z.enum(['slide', 'pop', 'fade', 'bounce']),
    position: z.enum(['top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right']),
    duration_ms: z.number().int().min(2000).max(60000),
    sound_id: z.string().uuid().nullable(),
    volume: z.number().int().min(0).max(100),
    tts_enabled: z.boolean(),
    tts_read_message: z.boolean(),
    min_amount_cents: z.number().int().min(0).max(10_000_000),
    accent_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
  })
  .partial()
  .strict();

/** Fills {viewerName} {giftCount} {amount} {months} for DISPLAY (rendered as text, never HTML). */
export function renderAlertText(template: string, v: { viewerName: string; giftCount?: number; amount?: string; months?: number }) {
  return template
    .replaceAll('{viewerName}', v.viewerName)
    .replaceAll('{giftCount}', String(v.giftCount ?? 1))
    .replaceAll('{amount}', v.amount ?? '')
    .replaceAll('{months}', String(v.months ?? 1))
    .slice(0, 200);
}

/** Same template for TTS: the name is sanitised exactly like viewer-name announcements. */
function spokenAlertText(template: string, v: { viewerName: string; giftCount?: number; amount?: string; months?: number; message?: string }, readMessage: boolean, blocked: string[]) {
  const prepared = sanitizeTemplate(
    template
      .replaceAll('{giftCount}', String(v.giftCount ?? 1))
      .replaceAll('{amount}', (v.amount ?? '').replace(/[^0-9.,]/g, '') + (v.amount?.startsWith('$') ? ' dollars' : ''))
      .replaceAll('{months}', String(v.months ?? 1)),
  );
  let text = renderAnnouncement(prepared, sanitizeSpokenName(v.viewerName, blocked), 'someone');
  if (readMessage && v.message) {
    const msg = sanitizeTemplate(v.message).replaceAll('{viewerName}', '');
    if (msg) text = `${text}. ${msg}`;
  }
  return text.slice(0, MAX_SPOKEN_TEXT);
}

/**
 * Creates and dispatches one alert. Idempotent per (kind, source): a
 * redelivered webhook finds the existing row and does nothing. Disabled or
 * below-minimum alerts are recorded as SKIPPED. TTS failure never prevents
 * the visual alert (recorded on the row).
 */
export async function createAlert(ctx: AppContext, intent: AlertIntent) {
  const settings = (await getAlertSettings(ctx.db, intent.streamerId))[intent.kind];
  const amount = intent.amountCents != null ? formatMoney(intent.amountCents, intent.currency ?? ctx.config.PAYMENT_CURRENCY) : undefined;
  const vars = { viewerName: cleanText(intent.viewerName, 40) || 'Someone', giftCount: intent.giftCount, amount, months: intent.months };
  const text = renderAlertText(settings.template, vars);
  const skipReason = !settings.enabled
    ? 'Alerts of this type are disabled'
    : intent.kind === 'donation' && (intent.amountCents ?? 0) < settings.min_amount_cents
      ? 'Below the minimum amount for alerts'
      : null;

  const inserted = await one<{ id: string }>(
    ctx.db,
    `INSERT INTO alert_events (streamer_id, kind, source_type, source_id, is_test, payload, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (kind, source_type, source_id) DO NOTHING RETURNING id`,
    [intent.streamerId, intent.kind, intent.sourceType, intent.sourceId, !!intent.isTest, JSON.stringify({ text, ...vars }), skipReason ? 'SKIPPED' : 'PENDING', skipReason],
  );
  if (!inserted) return { duplicate: true as const };
  if (skipReason) return { id: inserted.id, skipped: skipReason };

  let ttsAudioId: string | null = null;
  let ttsError: string | null = null;
  if (settings.tts_enabled) {
    try {
      if (!ctx.tts.available) throw new Error('Text-to-speech is not configured');
      const s = await getSettings(ctx.db, intent.streamerId);
      const spoken = spokenAlertText(settings.template, { ...vars, message: intent.message }, settings.tts_read_message, s.blocked_words);
      ttsAudioId = (await speakCached(ctx, intent.streamerId, spoken, `alert:${intent.kind}`)).audioId;
    } catch (err) {
      ttsError = `TTS: ${String((err as Error).message).slice(0, 200)}`;
    }
  }
  const sound = settings.sound_id
    ? await one<{ audio_file_id: string; duration_ms: number }>(ctx.db, 'SELECT audio_file_id, duration_ms FROM sounds WHERE id = $1 AND streamer_id = $2 AND deleted_at IS NULL AND is_active', [
        settings.sound_id,
        intent.streamerId,
      ])
    : null;

  const payload = {
    alertId: inserted.id,
    kind: intent.kind,
    isTest: !!intent.isTest,
    text,
    viewerName: vars.viewerName,
    avatarUrl: settings.show_avatar && intent.avatarUrl && /^https:\/\//.test(intent.avatarUrl) ? intent.avatarUrl : null,
    giftCount: intent.giftCount ?? null,
    months: intent.months ?? null,
    amount: amount ?? null,
    currency: intent.currency ?? null,
    message: settings.show_message && intent.message ? cleanText(intent.message, 300) : null,
    customMessage: settings.custom_message || null,
    soundAudioId: sound?.audio_file_id ?? null,
    ttsAudioId,
    animation: settings.animation,
    position: settings.position,
    durationMs: settings.duration_ms,
    volume: settings.volume,
    accentColor: settings.accent_color,
    createdAt: new Date().toISOString(),
  };
  await ctx.db.query('UPDATE alert_events SET payload = $2, tts_audio_file_id = $3, error = $4 WHERE id = $1', [inserted.id, JSON.stringify(payload), ttsAudioId, ttsError]);
  ctx.bus.publish(Topic.alerts(intent.streamerId, intent.kind), 'alert.show', payload);
  ctx.bus.publish(Topic.channel(intent.streamerId), 'alert.show', { alertId: inserted.id, kind: intent.kind, text, isTest: !!intent.isTest });
  return { id: inserted.id, payload };
}

/** Runs alert intents collected during a committed transaction. Never throws. */
export async function deliverAlerts(ctx: AppContext, intents: AlertIntent[]) {
  for (const intent of intents) {
    try {
      await createAlert(ctx, intent);
    } catch (err) {
      ctx.log.error({ err, intent: { kind: intent.kind, sourceId: intent.sourceId } }, 'alert delivery failed (reward/payment unaffected)');
    }
  }
}

/** Overlay acknowledgements: SHOWN when displayed, COMPLETED/FAILED when done. Guarded transitions. */
export async function ackAlert(db: Db, streamerId: string, kind: AlertKind, alertId: string, event: 'shown' | 'completed' | 'failed', detail?: string) {
  const sql = {
    shown: `UPDATE alert_events SET status = 'SHOWN', shown_at = now() WHERE id = $1 AND streamer_id = $2 AND kind = $3 AND status = 'PENDING'`,
    completed: `UPDATE alert_events SET status = 'COMPLETED', completed_at = now() WHERE id = $1 AND streamer_id = $2 AND kind = $3 AND status IN ('PENDING','SHOWN')`,
    failed: `UPDATE alert_events SET status = 'FAILED', error = COALESCE(error || '; ', '') || $4, completed_at = now() WHERE id = $1 AND streamer_id = $2 AND kind = $3 AND status IN ('PENDING','SHOWN')`,
  }[event];
  const r = await db.query(sql, event === 'failed' ? [alertId, streamerId, kind, (detail ?? 'overlay error').slice(0, 200)] : [alertId, streamerId, kind]);
  return r.rowCount > 0;
}

/** Alerts that fired in the last 2 minutes but were never shown (overlay was offline / reconnecting). */
export async function pendingAlerts(db: Db, streamerId: string, kind: AlertKind) {
  return many<{ payload: Record<string, unknown> }>(
    db,
    `SELECT payload FROM alert_events WHERE streamer_id = $1 AND kind = $2 AND status = 'PENDING' AND created_at > now() - interval '2 minutes' AND payload ? 'alertId' ORDER BY created_at LIMIT 10`,
    [streamerId, kind],
  );
}

const SAMPLE: Record<AlertKind, Omit<AlertIntent, 'streamerId' | 'kind' | 'sourceType' | 'sourceId'>> = {
  subscription: { viewerName: 'TrippyAlien', months: 3 },
  gift_sub: { viewerName: 'TrippyAlien', giftCount: 5 },
  donation: { viewerName: 'TrippyAlien', amountCents: 1000, currency: 'usd', message: 'Keep the streams coming!' },
};

/** Staff-only test alert. Clearly flagged isTest; it never creates points, subs or donations. */
export async function testAlert(ctx: AppContext, actor: SessionUser, streamerId: string, kind: AlertKind) {
  const r = await createAlert(ctx, { streamerId, kind, sourceType: 'test', sourceId: randomUUID(), isTest: true, avatarUrl: null, ...SAMPLE[kind], currency: SAMPLE[kind].currency ?? ctx.config.PAYMENT_CURRENCY });
  if ('skipped' in r && r.skipped) throw Errors.conflict(`Test not shown: ${r.skipped}`, 'ALERT_DISABLED');
  return { ...r, overlayConnected: ctx.bus.listenerCount(Topic.alerts(streamerId, kind)) > 0, actor: actor.username };
}

export async function listAlertEvents(db: Db, streamerId: string, limit: number, cursor: { t: string; id: string } | null, kind?: AlertKind) {
  const params: unknown[] = [streamerId];
  let where = 'a.streamer_id = $1';
  if (kind) {
    params.push(kind);
    where += ` AND a.kind = $${params.length}`;
  }
  if (cursor) {
    params.push(cursor.t, cursor.id);
    where += ` AND (a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  return many<{ id: string; created_at: Date }>(
    db,
    `SELECT a.id, a.kind, a.source_type, a.is_test, a.status, a.error, a.payload ->> 'text' AS text, a.created_at, a.shown_at, a.completed_at
       FROM alert_events a WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit + 1}`,
    params,
  );
}
