import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { one } from '../db/client.js';
import { AppError, Errors } from '../lib/errors.js';
import { processAudio } from '../audio/process.js';
import { getSettings, requireChannel } from './streamers.js';
import { overlayTokenMatchesChannel } from './overlays.js';
import type { SessionUser } from './types.js';

/** Hard platform ceiling regardless of channel settings (also enforced by multipart limits). */
export const PLATFORM_MAX_BYTES = 25 * 1024 * 1024;
const SOUND_MAX_SECONDS = 15;

export type AudioPurpose = 'MESSAGE' | 'SOUND' | 'DONATION';

export interface AudioFileRow {
  id: string;
  owner_id: string;
  streamer_id: string | null;
  purpose: AudioPurpose;
  storage_key: string;
  original_filename: string;
  mime_type: 'audio/mpeg' | 'audio/wav';
  container: 'mp3' | 'wav';
  size_bytes: number;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  waveform: number[];
  normalized_gain_db: number | null;
  scan_status: 'CLEAN' | 'SKIPPED';
  attached_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
}

export function publicAudio(a: AudioFileRow) {
  return {
    id: a.id,
    purpose: a.purpose,
    container: a.container,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
    durationMs: a.duration_ms,
    sampleRate: a.sample_rate,
    channels: a.channels,
    waveform: a.waveform,
    normalizedGainDb: a.normalized_gain_db,
    scanStatus: a.scan_status,
    createdAt: a.created_at,
  };
}

/**
 * Upload pipeline: authorization → limits from the target channel → strict
 * validation + processing → malware scan → storage → DB row. Every attempt
 * (success or failure) is recorded as an audio_processing_job for admins.
 */
export async function uploadAudio(
  ctx: AppContext,
  user: SessionUser,
  input: { buffer: Buffer; filename: string; mimeType: string; streamerId: string; purpose: AudioPurpose },
) {
  const streamer = await one<{ id: string; status: string }>(ctx.db, 'SELECT id, status FROM streamers WHERE id = $1 AND deleted_at IS NULL', [input.streamerId]);
  if (!streamer || streamer.status !== 'ACTIVE') throw Errors.notFound('Channel');
  const settings = await getSettings(ctx.db, input.streamerId);

  let maxSeconds = settings.max_audio_seconds;
  let maxBytes = Math.min(settings.max_file_bytes, PLATFORM_MAX_BYTES);
  if (input.purpose === 'SOUND') {
    await requireChannel(ctx.db, user, input.streamerId, 'manage');
    maxSeconds = SOUND_MAX_SECONDS;
    maxBytes = Math.min(PLATFORM_MAX_BYTES, 5 * 1024 * 1024);
  } else if (input.purpose === 'MESSAGE') {
    if (!settings.voice_enabled && !settings.mp3_enabled) throw Errors.featureDisabled('This streamer is not accepting audio messages');
  } else if (!settings.donation_voice_enabled) {
    throw Errors.featureDisabled('This streamer is not accepting voice donations');
  }

  const job = await one<{ id: string }>(
    ctx.db,
    `INSERT INTO audio_processing_jobs (owner_id, kind, status, details) VALUES ($1, 'VALIDATE_AND_PROCESS', 'RUNNING', $2) RETURNING id`,
    [user.id, JSON.stringify({ filename: input.filename.slice(0, 200), declaredMime: input.mimeType.slice(0, 100), bytes: input.buffer.length, purpose: input.purpose })],
  );
  const fail = async (err: unknown) => {
    const e = err as AppError;
    await ctx.db.query(`UPDATE audio_processing_jobs SET status = 'FAILED', error_code = $2, error = $3, finished_at = now() WHERE id = $1`, [
      job!.id,
      e.code ?? 'INTERNAL',
      String(e.message ?? err).slice(0, 500),
    ]);
  };

  try {
    const processed = processAudio({ buffer: input.buffer, filename: input.filename, declaredMime: input.mimeType, maxBytes, maxSeconds });
    const scan = await ctx.scanner.scan(input.buffer);
    if (scan.status === 'INFECTED') throw new AppError(422, 'MALWARE_DETECTED', 'This file was flagged by the malware scanner');

    const id = randomUUID();
    const key = `audio/${input.purpose.toLowerCase()}/${new Date().toISOString().slice(0, 10)}/${id}.${processed.container}`;
    await ctx.storage.put(key, processed.output, processed.mime);
    const row = await one<AudioFileRow>(
      ctx.db,
      `INSERT INTO audio_files (id, owner_id, streamer_id, purpose, storage_key, original_filename, mime_type, container, size_bytes, duration_ms,
                                sample_rate, channels, sha256, waveform, normalized_gain_db, scan_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        id,
        user.id,
        input.streamerId,
        input.purpose,
        key,
        input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'audio',
        processed.mime,
        processed.container,
        processed.output.length,
        processed.durationMs,
        processed.sampleRate,
        processed.channels,
        processed.sha256,
        JSON.stringify(processed.waveform),
        processed.gainDb,
        scan.status,
      ],
    );
    await ctx.db.query(`UPDATE audio_processing_jobs SET status = 'SUCCEEDED', audio_file_id = $2, finished_at = now(), details = details || $3 WHERE id = $1`, [
      job!.id,
      id,
      JSON.stringify({ steps: processed.steps, scanner: ctx.scanner.name, scan: scan.status }),
    ]);
    return row!;
  } catch (err) {
    await fail(err);
    throw err;
  }
}

/**
 * Authorization for streaming an audio file: the owner, staff of the channel
 * it was sent to, the channel's overlay (via overlay key), anyone for active
 * public sound effects, and admins.
 */
export async function canStreamAudio(
  ctx: AppContext,
  audio: AudioFileRow,
  who: { user: SessionUser | null; overlayKey?: string | null },
): Promise<boolean> {
  if (audio.deleted_at) return false;
  if (audio.purpose === 'SOUND') {
    const s = await one(ctx.db, 'SELECT 1 FROM sounds WHERE audio_file_id = $1 AND deleted_at IS NULL AND is_active', [audio.id]);
    if (s) return true;
  }
  if (who.overlayKey && audio.streamer_id) {
    if (await overlayTokenMatchesChannel(ctx.db, audio.streamer_id, who.overlayKey)) return true;
  }
  const user = who.user;
  if (!user) return false;
  if (audio.owner_id === user.id || user.role === 'ADMIN') return true;
  if (audio.streamer_id) {
    const staff = await one(
      ctx.db,
      `SELECT 1 FROM streamers s WHERE s.id = $1 AND (s.user_id = $2 OR EXISTS (SELECT 1 FROM streamer_moderators m WHERE m.streamer_id = s.id AND m.user_id = $2))`,
      [audio.streamer_id, user.id],
    );
    if (staff) return true;
  }
  return false;
}
