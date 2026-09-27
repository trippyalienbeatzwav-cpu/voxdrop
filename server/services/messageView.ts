import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import type { MessageStatus, MessageType } from './types.js';

export const MESSAGE_VIEW_SQL = `
  SELECT m.id, m.streamer_id, m.sender_id, m.type, m.text_content, m.audio_file_id, m.sound_id, m.donation_id,
         m.points_spent, m.bonus_points, m.is_priority, m.priority_tier, m.priority_points, m.status, m.flagged, m.flag_reason, m.rejection_reason,
         m.moderated_at, m.played_at, m.created_at, m.deleted_at,
         u.username AS sender_username, u.display_name AS sender_display_name, u.avatar_url AS sender_avatar,
         a.duration_ms AS audio_duration_ms, a.waveform AS audio_waveform, a.container AS audio_container,
         so.name AS sound_name, so.icon AS sound_icon, so.color AS sound_color, so.duration_ms AS sound_duration_ms,
         so.audio_file_id AS sound_audio_file_id, sa.waveform AS sound_waveform,
         d.amount_cents AS donation_amount_cents, d.currency AS donation_currency, d.is_anonymous AS donation_anonymous,
         s.slug AS streamer_slug, s.display_name AS streamer_display_name, s.avatar_url AS streamer_avatar,
         q.id AS queue_item_id, q.position AS queue_position, q.status AS queue_status, q.is_priority AS queue_priority,
         q.phase AS queue_phase, q.enqueued_at AS queue_enqueued_at, q.started_at AS queue_started_at, q.pinned_rank AS queue_pinned_rank, q.position AS queue_raw_position, q.announcement_status, q.announcement_text, q.announcement_audio_file_id, ann.duration_ms AS announcement_duration_ms,
         k.kick_username,
         mu.username AS moderated_by_username
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    JOIN streamers s ON s.id = m.streamer_id
    LEFT JOIN audio_files a ON a.id = m.audio_file_id
    LEFT JOIN sounds so ON so.id = m.sound_id
    LEFT JOIN audio_files sa ON sa.id = so.audio_file_id
    LEFT JOIN donations d ON d.id = m.donation_id
    LEFT JOIN playback_queue q ON q.message_id = m.id
    LEFT JOIN audio_files ann ON ann.id = q.announcement_audio_file_id
    LEFT JOIN kick_accounts k ON k.user_id = m.sender_id
    LEFT JOIN users mu ON mu.id = m.moderated_by`;

export interface MessageViewRow {
  id: string;
  streamer_id: string;
  sender_id: string;
  type: MessageType;
  text_content: string;
  audio_file_id: string | null;
  sound_id: string | null;
  donation_id: string | null;
  points_spent: number;
  bonus_points: number;
  is_priority: boolean;
  priority_tier: 'NORMAL' | 'PRIORITY' | 'HIGH' | 'VIP';
  priority_points: number;
  status: MessageStatus;
  flagged: boolean;
  flag_reason: string | null;
  rejection_reason: string | null;
  moderated_at: Date | null;
  played_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
  sender_username: string;
  sender_display_name: string;
  sender_avatar: string | null;
  audio_duration_ms: number | null;
  audio_waveform: number[] | null;
  audio_container: string | null;
  sound_name: string | null;
  sound_icon: string | null;
  sound_color: string | null;
  sound_duration_ms: number | null;
  sound_audio_file_id: string | null;
  sound_waveform: number[] | null;
  donation_amount_cents: number | null;
  donation_currency: string | null;
  donation_anonymous: boolean | null;
  streamer_slug: string;
  streamer_display_name: string;
  streamer_avatar: string | null;
  queue_item_id: string | null;
  queue_position: number | null;
  queue_status: string | null;
  queue_priority: boolean | null;
  queue_phase: string | null;
  queue_enqueued_at: Date | null;
  queue_started_at: Date | null;
  queue_pinned_rank: number | null;
  queue_raw_position: number | null;
  announcement_status: string | null;
  announcement_text: string | null;
  announcement_audio_file_id: string | null;
  announcement_duration_ms: number | null;
  kick_username: string | null;
  moderated_by_username: string | null;
}

/** Duration used for queue timing: audio length, sound length, or the text alert length. */
export function playDurationMs(r: Pick<MessageViewRow, 'type' | 'audio_duration_ms' | 'sound_duration_ms'>, alertMs: number) {
  if (r.type === 'VOICE' || r.type === 'MP3') return (r.audio_duration_ms ?? 0) + 800;
  if (r.type === 'SOUND') return Math.max(r.sound_duration_ms ?? 0, 2500);
  return alertMs;
}

export interface MessageAudio {
  id: string;
  durationMs: number | null;
  waveform: number[];
  container: string | null;
}

function audioOf(r: MessageViewRow): MessageAudio | null {
  if (r.type === 'SOUND') return r.sound_audio_file_id ? { id: r.sound_audio_file_id, durationMs: r.sound_duration_ms, waveform: r.sound_waveform ?? [], container: 'sound' } : null;
  return r.audio_file_id ? { id: r.audio_file_id, durationMs: r.audio_duration_ms, waveform: r.audio_waveform ?? [], container: r.audio_container } : null;
}

/**
 * Unified playback state exposed to clients:
 * MODERATION → APPROVED → QUEUED → ANNOUNCING → PLAYING → COMPLETED | SKIPPED | FAILED,
 * or REJECTED / EXPIRED. (PENDING is only the transient pre-validation state.)
 */
export type PlaybackState = 'PENDING' | 'MODERATION' | 'APPROVED' | 'QUEUED' | 'ANNOUNCING' | 'PLAYING' | 'COMPLETED' | 'SKIPPED' | 'REJECTED' | 'FAILED' | 'EXPIRED';

export function playbackStateOf(r: Pick<MessageViewRow, 'status' | 'queue_phase'>): PlaybackState {
  switch (r.status) {
    case 'PENDING':
      return 'MODERATION';
    case 'APPROVED':
      return 'APPROVED';
    case 'QUEUED':
      return 'QUEUED';
    case 'PLAYING':
      return r.queue_phase === 'ANNOUNCING' ? 'ANNOUNCING' : 'PLAYING';
    case 'PLAYED':
      return r.queue_phase === 'SKIPPED' ? 'SKIPPED' : 'COMPLETED';
    case 'REJECTED':
      return 'REJECTED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
      return r.queue_phase === 'FAILED' ? 'FAILED' : 'SKIPPED';
  }
}

export function toMessageView(r: MessageViewRow) {
  const anonymous = !!r.donation_anonymous;
  return {
    id: r.id,
    streamerId: r.streamer_id,
    streamer: { slug: r.streamer_slug, displayName: r.streamer_display_name, avatarUrl: r.streamer_avatar },
    sender: anonymous
      ? { id: null, username: 'anonymous', displayName: 'Anonymous', avatarUrl: null }
      : { id: r.sender_id, username: r.sender_username, displayName: r.sender_display_name, avatarUrl: r.sender_avatar },
    type: r.type,
    text: r.text_content,
    audio: audioOf(r),
    sound: r.sound_id ? { id: r.sound_id, name: r.sound_name, icon: r.sound_icon, color: r.sound_color } : null,
    donation: r.donation_id ? { id: r.donation_id, amountCents: r.donation_amount_cents, currency: r.donation_currency } : null,
    pointsSpent: r.points_spent,
    bonusPoints: r.bonus_points,
    isPriority: r.is_priority,
    priorityTier: r.priority_tier,
    priorityPoints: r.priority_points,
    playbackState: playbackStateOf(r),
    status: r.status,
    flagged: r.flagged,
    flagReason: r.flag_reason,
    rejectionReason: r.rejection_reason,
    moderatedBy: r.moderated_by_username,
    moderatedAt: r.moderated_at,
    playedAt: r.played_at,
    createdAt: r.created_at,
    queue: r.queue_item_id
      ? {
          itemId: r.queue_item_id,
          status: r.queue_status,
          position: r.queue_position,
          priority: r.queue_priority,
          phase: r.queue_phase,
          announcement: {
            status: r.announcement_status,
            text: r.announcement_text,
            audioId: r.announcement_audio_file_id,
            durationMs: r.announcement_duration_ms,
          },
        }
      : null,
  };
}

export type MessageView = ReturnType<typeof toMessageView>;

export async function getMessageView(db: Db, id: string): Promise<MessageView | null> {
  const r = await one<MessageViewRow>(db, `${MESSAGE_VIEW_SQL} WHERE m.id = $1`, [id]);
  return r ? toMessageView(r) : null;
}

export async function getMessageViews(db: Db, where: string, params: unknown[], tail = ''): Promise<MessageViewRow[]> {
  return many<MessageViewRow>(db, `${MESSAGE_VIEW_SQL} WHERE ${where} ${tail}`, params);
}
