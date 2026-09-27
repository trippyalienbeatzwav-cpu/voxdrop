export type Role = 'VIEWER' | 'STREAMER' | 'MODERATOR' | 'ADMIN';

export interface SessionUser {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  reduced_motion: boolean;
}

export interface StreamerRow {
  id: string;
  user_id: string;
  slug: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  banner_url: string | null;
  kick_broadcaster_user_id: string | null;
  is_live: boolean;
  live_title: string | null;
  brand_color: string;
  overlay_key: string;
  queue_paused: boolean;
  kick_events_subscribed_at: Date | null;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: Date;
}

export interface StreamerSettings {
  streamer_id: string;
  text_enabled: boolean;
  voice_enabled: boolean;
  mp3_enabled: boolean;
  sounds_enabled: boolean;
  donations_enabled: boolean;
  max_audio_seconds: number;
  max_file_bytes: number;
  price_text: number;
  price_voice: number;
  price_mp3: number;
  price_priority: number;
  sound_price_default: number;
  min_points_per_message: number;
  max_points_per_message: number;
  free_text_per_day: number;
  cooldown_seconds: number;
  daily_message_limit: number;
  queue_limit: number;
  blocked_words: string[];
  approval_mode: 'AUTO' | 'MANUAL';
  auto_reject_blocked_words: boolean;
  moderators_can_approve: boolean;
  refund_on_reject: boolean;
  message_expiry_minutes: number;
  rewards_enabled: boolean;
  sub_reward_points: number;
  resub_reward_points: number;
  gift_reward_points: number;
  multi_gift_threshold: number;
  multi_gift_bonus_points: number;
  giftee_reward_points: number;
  follow_reward_points: number;
  reward_daily_cap_per_user: number;
  max_gifts_rewarded_per_event: number;
  streamer_grant_daily_cap: number;
  donation_min_cents: number;
  donation_max_cents: number;
  donation_voice_enabled: boolean;
  auto_queue_approved: boolean;
  auto_play: boolean;
  playback_gap_ms: number;
  playback_volume: number;
  alert_duration_ms: number;
  alert_style: 'slide' | 'pop' | 'minimal';
  overlay_show_avatar: boolean;
  overlay_show_points: boolean;
  announce_enabled: boolean;
  announce_types: AnnounceKind[];
  announce_voice: string;
  announce_locale: string;
  announce_speed: number;
  announce_volume: number;
  announce_template_voice: string;
  announce_template_mp3: string;
  announce_template_donation: string;
  announce_template_sound: string;
  announce_version: number;
}

export type AnnounceKind = 'VOICE' | 'MP3' | 'DONATION' | 'SOUND';

export type MessageStatus = 'PENDING' | 'APPROVED' | 'QUEUED' | 'PLAYING' | 'PLAYED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
export type MessageType = 'TEXT' | 'VOICE' | 'MP3' | 'SOUND';

export interface MessageRow {
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
  created_at: Date;
  played_at: Date | null;
  deleted_at: Date | null;
}
