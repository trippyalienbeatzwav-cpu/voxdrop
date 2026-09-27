import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import { isUniqueViolation, many, one } from '../db/client.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, Errors } from '../lib/errors.js';
import { renderAnnouncement, sanitizeSpokenName, type SpokenName } from '../lib/speech.js';
import { parseWav, WavError } from '../audio/wav.js';
import { Topic } from '../events/bus.js';
import { getSettings } from './streamers.js';
import type { AnnounceKind, StreamerSettings } from './types.js';

/** Hard budget for one synthesis — a slow TTS must never stall the stream. */
export const TTS_TIMEOUT_MS = 8000;
/** Estimated length used for queue ETAs before an announcement is generated. */
export const ESTIMATED_ANNOUNCEMENT_MS = 2000;

export type AnnouncementStatus = 'NONE' | 'PENDING' | 'READY' | 'FAILED' | 'PLAYED' | 'SKIPPED';
export type Phase = 'PENDING' | 'ANNOUNCING' | 'PLAYING_MESSAGE' | 'COMPLETED' | 'SKIPPED' | 'FAILED';

interface ItemRow {
  id: string;
  streamer_id: string;
  status: string;
  phase: Phase;
  announcement_status: AnnouncementStatus;
  announcement_text: string | null;
  announcement_audio_file_id: string | null;
  message_id: string;
  type: 'TEXT' | 'VOICE' | 'MP3' | 'SOUND';
  sender_id: string;
  donation_id: string | null;
  donation_anonymous: boolean | null;
  owner_id: string;
  kick_username: string | null;
  display_name: string;
}

const ITEM_SQL = `
  SELECT q.id, q.streamer_id, q.status, q.phase, q.announcement_status, q.announcement_text, q.announcement_audio_file_id, q.message_id,
         m.type, m.sender_id, m.donation_id, d.is_anonymous AS donation_anonymous, s.user_id AS owner_id,
         k.kick_username, u.display_name
    FROM playback_queue q
    JOIN messages m ON m.id = q.message_id
    JOIN streamers s ON s.id = q.streamer_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN kick_accounts k ON k.user_id = m.sender_id
    LEFT JOIN donations d ON d.id = m.donation_id`;

/** Which announcement (if any) a message gets. Text-only chat and the streamer's own soundboard are not announced. */
export function announcementKind(m: { type: string; donation_id: string | null; sender_id: string }, ownerId: string): AnnounceKind | null {
  if (m.sender_id === ownerId) return null;
  if (m.donation_id) return 'DONATION';
  if (m.type === 'VOICE') return 'VOICE';
  if (m.type === 'MP3') return 'MP3';
  if (m.type === 'SOUND') return 'SOUND';
  return null;
}

export function isEligible(s: Pick<StreamerSettings, 'announce_enabled' | 'announce_types'>, kind: AnnounceKind | null, ttsAvailable: boolean) {
  return !!kind && ttsAvailable && s.announce_enabled && s.announce_types.includes(kind);
}

export function templateFor(s: StreamerSettings, kind: AnnounceKind) {
  return { VOICE: s.announce_template_voice, MP3: s.announce_template_mp3, DONATION: s.announce_template_donation, SOUND: s.announce_template_sound }[kind];
}

/**
 * The name we speak is the viewer's Kick username (not the editable VoxDrop
 * display name) — sanitised, length-limited, and checked against the
 * channel's blocked words. Anonymous donations never reveal the name.
 */
export function spokenNameFor(row: Pick<ItemRow, 'kick_username' | 'display_name' | 'donation_anonymous'>, blocked: string[]): SpokenName & { fallback: string } {
  if (row.donation_anonymous) return { name: null, reason: 'empty', fallback: 'an anonymous viewer' };
  return { ...sanitizeSpokenName(row.kick_username ?? row.display_name, blocked), fallback: 'a viewer' };
}

export function cacheKey(p: { streamerId: string; viewerId: string; spoken: string; provider: string; voice: string; locale: string; speed: number; version: number }) {
  return sha256(['v1', p.streamerId, p.viewerId, p.spoken, p.provider, p.voice, p.locale, p.speed.toFixed(2), p.version].join('␟'));
}

// In-flight de-duplication: concurrent requests for the same item / same audio share one synthesis.
const inflightItems = new Map<string, Promise<unknown>>();
const inflightKeys = new Map<string, Promise<string>>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError(504, 'TTS_TIMEOUT', 'Speech synthesis took too long')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Synthesises `text` (or reuses the cached audio for the same key) and stores
 * it as a private ANNOUNCEMENT audio file owned by the channel owner.
 */
async function audioFor(ctx: AppContext, a: { streamerId: string; ownerId: string; key: string; version: number; text: string; s: StreamerSettings }): Promise<{ audioId: string; cached: boolean }> {
  const hit = await one<{ audio_file_id: string }>(
    ctx.db,
    `UPDATE announcement_cache SET hit_count = hit_count + 1, last_used_at = now() WHERE cache_key = $1 RETURNING audio_file_id`,
    [a.key],
  );
  if (hit) return { audioId: hit.audio_file_id, cached: true };

  let p = inflightKeys.get(a.key);
  if (!p) {
    p = (async () => {
      const wav = await withTimeout(ctx.tts.synthesize({ text: a.text, voice: a.s.announce_voice, locale: a.s.announce_locale, speed: a.s.announce_speed }), TTS_TIMEOUT_MS);
      let info;
      try {
        info = parseWav(wav);
      } catch (e) {
        throw new AppError(502, 'TTS_FAILED', `TTS returned invalid audio: ${(e as WavError).message}`);
      }
      const id = randomUUID();
      const storageKey = `audio/announcement/${a.streamerId}/${id}.wav`;
      await ctx.storage.put(storageKey, wav, 'audio/wav');
      await ctx.db.query(
        `INSERT INTO audio_files (id, owner_id, streamer_id, purpose, storage_key, original_filename, mime_type, container, size_bytes, duration_ms,
                                  sample_rate, channels, sha256, waveform, scan_status, attached_at)
         VALUES ($1,$2,$3,'ANNOUNCEMENT',$4,'announcement.wav','audio/wav','wav',$5,$6,$7,$8,$9,'[]','SKIPPED', now())`,
        [id, a.ownerId, a.streamerId, storageKey, wav.length, Math.max(1, info.durationMs), info.sampleRate, info.channels, sha256(wav)],
      );
      try {
        await ctx.db.query(`INSERT INTO announcement_cache (streamer_id, cache_key, version, spoken_text, audio_file_id) VALUES ($1,$2,$3,$4,$5)`, [
          a.streamerId,
          a.key,
          a.version,
          a.text,
          id,
        ]);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await one<{ audio_file_id: string }>(ctx.db, 'SELECT audio_file_id FROM announcement_cache WHERE cache_key = $1', [a.key]);
        if (existing) return existing.audio_file_id;
      }
      return id;
    })();
    inflightKeys.set(a.key, p);
    p.finally(() => inflightKeys.delete(a.key)).catch(() => undefined);
  }
  return { audioId: await p, cached: false };
}

export interface PreparedAnnouncement {
  status: AnnouncementStatus;
  text: string | null;
  audioId: string | null;
  durationMs: number | null;
}

async function describe(db: Db, itemId: string): Promise<PreparedAnnouncement> {
  const r = await one<{ announcement_status: AnnouncementStatus; announcement_text: string | null; announcement_audio_file_id: string | null; duration_ms: number | null }>(
    db,
    `SELECT q.announcement_status, q.announcement_text, q.announcement_audio_file_id, a.duration_ms
       FROM playback_queue q LEFT JOIN audio_files a ON a.id = q.announcement_audio_file_id WHERE q.id = $1`,
    [itemId],
  );
  return { status: r?.announcement_status ?? 'NONE', text: r?.announcement_text ?? null, audioId: r?.announcement_audio_file_id ?? null, durationMs: r?.duration_ms ?? null };
}

/**
 * Makes sure a queue item's announcement is generated (or reused from cache).
 * Idempotent and safe to call concurrently. Failures are recorded on the item
 * (status FAILED + error) — the message then plays without an announcement.
 */
export async function prepareItem(ctx: AppContext, itemId: string): Promise<PreparedAnnouncement> {
  const running = inflightItems.get(itemId);
  if (running) {
    await running.catch(() => undefined);
    return describe(ctx.db, itemId);
  }
  const job = (async () => {
    const row = await one<ItemRow>(ctx.db, `${ITEM_SQL} WHERE q.id = $1`, [itemId]);
    if (!row || !['QUEUED', 'PLAYING'].includes(row.status)) return;
    if (['READY', 'FAILED', 'PLAYED', 'SKIPPED'].includes(row.announcement_status)) return;
    const s = await getSettings(ctx.db, row.streamer_id);
    const kind = announcementKind(row, row.owner_id);
    if (!isEligible(s, kind, ctx.tts.available)) return; // stays NONE → message plays directly

    const spoken = spokenNameFor(row, s.blocked_words);
    const text = renderAnnouncement(templateFor(s, kind!), spoken, spoken.fallback);
    const claimed = await ctx.db.query(`UPDATE playback_queue SET announcement_status = 'PENDING', announcement_text = $2, viewer_name = $3 WHERE id = $1 AND announcement_status IN ('NONE','PENDING')`, [
      itemId,
      text,
      spoken.name ?? spoken.fallback,
    ]);
    if (!claimed.rowCount) return;
    try {
      const key = cacheKey({
        streamerId: row.streamer_id,
        viewerId: row.donation_anonymous ? 'anonymous' : row.sender_id,
        spoken: text,
        provider: ctx.tts.name,
        voice: s.announce_voice,
        locale: s.announce_locale,
        speed: s.announce_speed,
        version: s.announce_version,
      });
      const { audioId, cached } = await audioFor(ctx, { streamerId: row.streamer_id, ownerId: row.owner_id, key, version: s.announce_version, text, s });
      await ctx.db.query(
        `UPDATE playback_queue SET announcement_status = 'READY', announcement_audio_file_id = $2, announcement_cached = $3, announcement_generated_at = now(), error = NULL
          WHERE id = $1 AND announcement_status = 'PENDING'`,
        [itemId, audioId, cached],
      );
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 300);
      await ctx.db.query(`UPDATE playback_queue SET announcement_status = 'FAILED', error = $2 WHERE id = $1 AND announcement_status = 'PENDING'`, [itemId, `Announcement: ${msg}`]);
      ctx.bus.publish(Topic.channel(row.streamer_id), 'announcement.failed', { itemId, messageId: row.message_id, stage: 'generate', error: msg });
      ctx.log.warn({ err, itemId }, 'announcement generation failed');
    }
  })();
  inflightItems.set(itemId, job);
  try {
    await job;
  } finally {
    inflightItems.delete(itemId);
  }
  return describe(ctx.db, itemId);
}

/** Pre-generates announcements for the next few queued items so playback never waits on TTS. */
export async function warmQueue(ctx: AppContext, streamerId: string, limit = 5) {
  const rows = await many<{ id: string }>(
    ctx.db,
    `SELECT id FROM playback_queue WHERE streamer_id = $1 AND status = 'QUEUED' AND announcement_status = 'NONE'
      ORDER BY is_priority DESC, position ASC LIMIT $2`,
    [streamerId, limit],
  );
  for (const r of rows) await prepareItem(ctx, r.id).catch((err) => ctx.log.warn({ err }, 'warm failed'));
}

/** Sample announcement for the settings screen (draft values, not cached, not stored). */
export async function previewAudio(ctx: AppContext, streamerId: string, draft: Partial<StreamerSettings> & { kind?: AnnounceKind; viewerName?: string }) {
  if (!ctx.tts.available) throw Errors.featureDisabled('Text-to-speech is not configured on this server');
  const s = { ...(await getSettings(ctx.db, streamerId)), ...draft } as StreamerSettings;
  const kind = draft.kind ?? 'VOICE';
  const spoken = { ...sanitizeSpokenName(draft.viewerName ?? 'TrippyAlien', s.blocked_words), fallback: 'a viewer' };
  const text = renderAnnouncement(templateFor(s, kind), spoken, spoken.fallback);
  try {
    const wav = await withTimeout(ctx.tts.synthesize({ text, voice: s.announce_voice, locale: s.announce_locale, speed: s.announce_speed }), TTS_TIMEOUT_MS);
    parseWav(wav);
    return { wav, text };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'TTS_FAILED', 'Could not generate the preview');
  }
}

/** Cached TTS for arbitrary (already sanitised) text using the channel's voice settings — used by alerts. */
export async function speakCached(ctx: AppContext, streamerId: string, text: string, scope: string) {
  const s = await getSettings(ctx.db, streamerId);
  const owner = await one<{ user_id: string }>(ctx.db, 'SELECT user_id FROM streamers WHERE id = $1', [streamerId]);
  const key = cacheKey({ streamerId, viewerId: scope, spoken: text, provider: ctx.tts.name, voice: s.announce_voice, locale: s.announce_locale, speed: s.announce_speed, version: s.announce_version });
  return audioFor(ctx, { streamerId, ownerId: owner!.user_id, key, version: s.announce_version, text, s });
}

/** Test announcement pushed to the OBS overlay (plays only if the overlay is idle). */
export async function testOnStream(ctx: AppContext, streamerId: string) {
  const s = await getSettings(ctx.db, streamerId);
  const owner = await one<{ user_id: string; display_name: string }>(ctx.db, 'SELECT user_id, display_name FROM streamers WHERE id = $1', [streamerId]);
  const spoken = { ...sanitizeSpokenName('TrippyAlien'), fallback: 'a viewer' };
  const text = renderAnnouncement(s.announce_template_voice, spoken, spoken.fallback);
  const key = cacheKey({ streamerId, viewerId: 'test', spoken: text, provider: ctx.tts.name, voice: s.announce_voice, locale: s.announce_locale, speed: s.announce_speed, version: s.announce_version });
  if (!ctx.tts.available) throw Errors.featureDisabled('Text-to-speech is not configured on this server');
  const { audioId } = await audioFor(ctx, { streamerId, ownerId: owner!.user_id, key, version: s.announce_version, text, s });
  ctx.bus.publish(Topic.overlay(streamerId), 'overlay.announcement_test', { audioId, text, volume: s.announce_volume });
  return { audioId, text, overlayConnected: ctx.bus.listenerCount(Topic.overlay(streamerId)) > 0 };
}

// ── Playback state machine (driven by the OBS overlay's real audio events) ────

const ANNOUNCEMENT_OUTSTANDING = new Set<AnnouncementStatus>(['PENDING', 'READY']);

export type PlaybackEvent = 'started' | 'announcement_started' | 'announcement_ended' | 'announcement_error' | 'message_started' | 'ended' | 'error';

export interface EventResult {
  ok: boolean;
  ignored?: 'not_current' | 'duplicate' | 'out_of_order';
  finish?: 'PLAYED' | 'FAILED';
  error?: string;
}

/**
 * Applies one overlay playback event to the PLAYING item. Every transition is
 * guarded by the expected previous phase, so duplicate or stale events are
 * harmless, and the viewer's audio is refused until its announcement has
 * finished (or failed) — the announcement always comes first.
 */
export async function applyPlaybackEvent(ctx: AppContext, streamerId: string, itemId: string, event: PlaybackEvent, detail?: string): Promise<EventResult> {
  const item = await one<{ id: string; status: string; phase: Phase; announcement_status: AnnouncementStatus; message_id: string }>(
    ctx.db,
    'SELECT id, status, phase, announcement_status, message_id FROM playback_queue WHERE id = $1 AND streamer_id = $2',
    [itemId, streamerId],
  );
  if (!item || item.status !== 'PLAYING') return { ok: true, ignored: 'not_current' };
  const ch = Topic.channel(streamerId);
  const base = { itemId, messageId: item.message_id };
  const upd = async (sql: string, params: unknown[] = []) => (await ctx.db.query(`UPDATE playback_queue SET ${sql} WHERE id = $1 AND status = 'PLAYING'`, [itemId, ...params])).rowCount > 0;

  switch (event) {
    case 'started':
      return { ok: true };
    case 'announcement_started': {
      if (item.announcement_status !== 'READY' || item.phase !== 'PENDING') return { ok: true, ignored: 'duplicate' };
      await upd(`phase = 'ANNOUNCING', announcement_started_at = now()`);
      ctx.bus.publish(ch, 'announcement.started', base);
      return { ok: true };
    }
    case 'announcement_ended': {
      if (item.phase !== 'ANNOUNCING' || item.announcement_status !== 'READY') return { ok: true, ignored: 'duplicate' };
      await upd(`announcement_status = 'PLAYED', announcement_finished_at = now()`);
      ctx.bus.publish(ch, 'announcement.completed', base);
      return { ok: true };
    }
    case 'announcement_error': {
      if (!['PENDING', 'ANNOUNCING'].includes(item.phase) || !['READY'].includes(item.announcement_status)) return { ok: true, ignored: 'duplicate' };
      const reason = `Announcement playback: ${(detail ?? 'audio failed to load').slice(0, 200)}`;
      await upd(`announcement_status = 'FAILED', announcement_finished_at = now(), error = $2`, [reason]);
      ctx.bus.publish(ch, 'announcement.failed', { ...base, stage: 'playback', error: reason });
      return { ok: true };
    }
    case 'message_started': {
      if (item.phase === 'PLAYING_MESSAGE') return { ok: true, ignored: 'duplicate' };
      // Order guarantee: a pending/ready announcement must play (or fail) before the viewer's audio.
      if (ANNOUNCEMENT_OUTSTANDING.has(item.announcement_status)) return { ok: false, ignored: 'out_of_order', error: 'ANNOUNCEMENT_NOT_FINISHED' };
      await upd(`phase = 'PLAYING_MESSAGE', message_started_at = now()`);
      ctx.bus.publish(ch, 'message.audio.started', base);
      return { ok: true };
    }
    case 'ended': {
      // Also accepted without message_started (text-only donations, older overlays) — never while an announcement is outstanding.
      if (ANNOUNCEMENT_OUTSTANDING.has(item.announcement_status)) return { ok: false, ignored: 'out_of_order', error: 'ANNOUNCEMENT_NOT_FINISHED' };
      await upd(`message_finished_at = now()`);
      ctx.bus.publish(ch, 'message.audio.completed', base);
      return { ok: true, finish: 'PLAYED' };
    }
    case 'error': {
      const reason = `Message playback: ${(detail ?? 'audio failed to load').slice(0, 200)}`;
      await upd(`error = $2`, [reason]);
      return { ok: true, finish: 'FAILED', error: reason };
    }
  }
}

/** Playback log rows for the streamer History page. */
export async function playbackLog(db: Db, streamerId: string, limit: number, cursor: { t: string; id: string } | null) {
  const params: unknown[] = [streamerId];
  let where = `q.streamer_id = $1 AND q.finished_at IS NOT NULL`;
  if (cursor) {
    params.push(cursor.t, cursor.id);
    where += ` AND (q.finished_at, q.id) < ($2::timestamptz, $3::uuid)`;
  }
  const rows = await many<Record<string, unknown> & { id: string; finished_at: Date }>(
    db,
    `SELECT q.id, q.message_id, q.phase, q.status, q.announcement_status, q.announcement_text, q.announcement_cached, q.error,
            q.started_at, q.finished_at, q.announcement_started_at, q.announcement_finished_at, q.message_started_at, q.message_finished_at,
            COALESCE(q.viewer_name, CASE WHEN d.is_anonymous THEN 'Anonymous' ELSE COALESCE(k.kick_username, u.display_name) END) AS viewer_name,
            m.type, (m.donation_id IS NOT NULL) AS is_donation,
            EXTRACT(EPOCH FROM (q.finished_at - COALESCE(q.announcement_started_at, q.message_started_at, q.started_at))) * 1000 AS duration_ms
       FROM playback_queue q JOIN messages m ON m.id = q.message_id JOIN users u ON u.id = m.sender_id
       LEFT JOIN kick_accounts k ON k.user_id = m.sender_id LEFT JOIN donations d ON d.id = m.donation_id
      WHERE ${where} ORDER BY q.finished_at DESC, q.id DESC LIMIT ${limit + 1}`,
    params,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({ ...r, duration_ms: r.duration_ms == null ? null : Math.round(Number(r.duration_ms)) }));
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ t: new Date(last.finished_at).toISOString(), id: last.id })).toString('base64url') : null,
  };
}
