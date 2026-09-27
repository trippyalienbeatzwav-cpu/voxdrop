import { z } from 'zod';
import type { Db } from '../db/client.js';
import { many, one } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { cleanText, slugify } from '../lib/text.js';
import { sanitizeTemplate } from '../lib/speech.js';

const AUDIO_AFFECTING = new Set(['announce_voice', 'announce_locale', 'announce_speed', 'announce_template_voice', 'announce_template_mp3', 'announce_template_donation', 'announce_template_sound', 'blocked_words']);
import { audit } from './audit.js';
import type { SessionUser, StreamerRow, StreamerSettings } from './types.js';
import type { KickChannel } from '../integrations/kick/types.js';

export type ChannelAccess = 'owner' | 'moderator' | 'admin';

/** Slugs that would collide with app routes under /streamer/*. */
const RESERVED_SLUGS = new Set(['login', 'obs', 'priority', 'alerts', 'gift-subs', 'overview', 'become', 'dashboard', 'queue', 'messages', 'sounds', 'soundboard', 'points', 'donations', 'subscribers', 'users', 'moderation', 'analytics', 'history', 'settings', 'integrations', 'admin', 'api']);

/**
 * Resolves what the user may do on a channel. Enforced on every management
 * endpoint — the UI hiding a button is never the security boundary.
 */
export async function channelAccess(db: Db, user: SessionUser, streamerId: string): Promise<ChannelAccess | null> {
  if (user.status !== 'ACTIVE') return null;
  const s = await one<{ user_id: string }>(db, 'SELECT user_id FROM streamers WHERE id = $1 AND deleted_at IS NULL', [streamerId]);
  if (!s) throw Errors.notFound('Channel');
  if (s.user_id === user.id) return 'owner';
  if (user.role === 'ADMIN') return 'admin';
  const mod = await one(db, 'SELECT 1 FROM streamer_moderators WHERE streamer_id = $1 AND user_id = $2', [streamerId, user.id]);
  return mod ? 'moderator' : null;
}

/** `moderate` = owner, moderators and admins; `manage` = owner and admins only. */
export async function requireChannel(db: Db, user: SessionUser, streamerId: string, need: 'moderate' | 'manage'): Promise<ChannelAccess> {
  const access = await channelAccess(db, user, streamerId);
  if (!access) throw Errors.forbidden('You are not staff on this channel');
  if (need === 'manage' && access === 'moderator') throw Errors.forbidden('Only the channel owner can change this');
  return access;
}

export async function getStreamer(db: Db, id: string): Promise<StreamerRow> {
  const s = await one<StreamerRow>(db, 'SELECT * FROM streamers WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!s) throw Errors.notFound('Channel');
  return s;
}

export async function getStreamerBySlug(db: Db, slug: string): Promise<StreamerRow> {
  const s = await one<StreamerRow>(db, 'SELECT * FROM streamers WHERE lower(slug) = lower($1) AND deleted_at IS NULL', [slug]);
  if (!s) throw Errors.notFound('Streamer');
  return s;
}

export async function getSettings(db: Db, streamerId: string): Promise<StreamerSettings> {
  const s = await one<StreamerSettings>(db, 'SELECT * FROM streamer_settings WHERE streamer_id = $1', [streamerId]);
  if (!s) throw Errors.notFound('Channel settings');
  return s;
}

export async function ownStreamer(db: Db, userId: string): Promise<StreamerRow | null> {
  return one<StreamerRow>(db, 'SELECT * FROM streamers WHERE user_id = $1 AND deleted_at IS NULL', [userId]);
}

/** Channels the user can staff (owned + moderated). */
export async function staffChannels(db: Db, userId: string) {
  return many<{ id: string; slug: string; display_name: string; avatar_url: string | null; is_live: boolean; access: 'owner' | 'moderator' }>(
    db,
    `SELECT s.id, s.slug, s.display_name, s.avatar_url, s.is_live, 'owner' AS access FROM streamers s WHERE s.user_id = $1 AND s.deleted_at IS NULL
     UNION ALL
     SELECT s.id, s.slug, s.display_name, s.avatar_url, s.is_live, 'moderator' AS access
       FROM streamer_moderators m JOIN streamers s ON s.id = m.streamer_id
      WHERE m.user_id = $1 AND s.deleted_at IS NULL`,
    [userId],
  );
}

/** Creates (or refreshes) the streamer profile linked to a Kick channel. */
export async function upsertStreamerFromKick(db: Db, user: SessionUser, channel: KickChannel, avatar: string | null): Promise<StreamerRow> {
  return db.tx(async (q) => {
    const existing = await one<StreamerRow>(q, 'SELECT * FROM streamers WHERE user_id = $1 AND deleted_at IS NULL', [user.id]);
    if (existing) {
      const updated = await one<StreamerRow>(
        q,
        `UPDATE streamers SET kick_broadcaster_user_id = $2, is_live = $3, live_title = $4, banner_url = COALESCE($5, banner_url),
                avatar_url = COALESCE($6, avatar_url), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, channel.broadcasterUserId, channel.isLive, channel.streamTitle, channel.bannerPicture, avatar],
      );
      return updated!;
    }
    let slug = slugify(channel.slug) || slugify(user.username);
    if (RESERVED_SLUGS.has(slug)) slug = `${slug}-tv`;
    if (await one(q, 'SELECT 1 FROM streamers WHERE lower(slug) = lower($1) AND deleted_at IS NULL', [slug])) slug = `${slug}-${randomToken(3).toLowerCase()}`;
    const s = await one<StreamerRow>(
      q,
      `INSERT INTO streamers (user_id, slug, display_name, bio, avatar_url, banner_url, kick_broadcaster_user_id, is_live, live_title, overlay_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [user.id, slug, user.display_name, cleanText(channel.description, 500), avatar, channel.bannerPicture, channel.broadcasterUserId, channel.isLive, channel.streamTitle, randomToken(24)],
    );
    await q.query('INSERT INTO streamer_settings (streamer_id) VALUES ($1)', [s!.id]);
    if (user.role !== 'ADMIN') await q.query(`UPDATE users SET role = 'STREAMER', updated_at = now() WHERE id = $1`, [user.id]);
    await audit(q, { actorUserId: user.id, streamerId: s!.id, action: 'streamer.created', entityType: 'streamer', entityId: s!.id, metadata: { slug } });
    return s!;
  });
}

// ── Settings ────────────────────────────────────────────────────────────────

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const settingsSchema = z
  .object({
    text_enabled: z.boolean(),
    voice_enabled: z.boolean(),
    mp3_enabled: z.boolean(),
    sounds_enabled: z.boolean(),
    donations_enabled: z.boolean(),
    max_audio_seconds: int(3, 300),
    max_file_bytes: int(65536, 26214400),
    price_text: int(0, 1_000_000),
    price_voice: int(0, 1_000_000),
    price_mp3: int(0, 1_000_000),
    price_priority: int(0, 1_000_000),
    sound_price_default: int(0, 1_000_000),
    min_points_per_message: int(0, 1_000_000),
    max_points_per_message: int(1, 10_000_000),
    free_text_per_day: int(0, 100),
    cooldown_seconds: int(0, 86400),
    daily_message_limit: int(0, 1000),
    queue_limit: int(1, 1000),
    blocked_words: z.array(z.string().trim().min(1).max(40)).max(500),
    approval_mode: z.enum(['AUTO', 'MANUAL']),
    auto_reject_blocked_words: z.boolean(),
    moderators_can_approve: z.boolean(),
    refund_on_reject: z.boolean(),
    message_expiry_minutes: int(5, 10080),
    rewards_enabled: z.boolean(),
    sub_reward_points: int(0, 100_000),
    resub_reward_points: int(0, 100_000),
    gift_reward_points: int(0, 100_000),
    multi_gift_threshold: int(2, 1000),
    multi_gift_bonus_points: int(0, 1_000_000),
    giftee_reward_points: int(0, 100_000),
    follow_reward_points: int(0, 10_000),
    reward_daily_cap_per_user: int(0, 10_000_000),
    max_gifts_rewarded_per_event: int(1, 1000),
    streamer_grant_daily_cap: int(0, 1_000_000),
    donation_min_cents: int(50, 1_000_000),
    donation_max_cents: int(50, 10_000_000),
    donation_voice_enabled: z.boolean(),
    auto_queue_approved: z.boolean(),
    auto_play: z.boolean(),
    playback_gap_ms: int(0, 30000),
    playback_volume: int(0, 100),
    alert_duration_ms: int(1000, 30000),
    alert_style: z.enum(['slide', 'pop', 'minimal']),
    overlay_show_avatar: z.boolean(),
    overlay_show_points: z.boolean(),
    announce_enabled: z.boolean(),
    announce_types: z.array(z.enum(['VOICE', 'MP3', 'DONATION', 'SOUND'])).max(4),
    announce_voice: z.string().trim().max(100).regex(/^[\p{L}\p{N} ()._+-]*$/u, 'Invalid voice name'),
    announce_locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Use a locale like en-US'),
    announce_speed: z.number().min(0.5).max(2),
    announce_volume: int(0, 100),
    announce_template_voice: z.string().trim().min(1).max(120),
    announce_template_mp3: z.string().trim().min(1).max(120),
    announce_template_donation: z.string().trim().min(1).max(120),
    announce_template_sound: z.string().trim().min(1).max(120),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof settingsSchema>;

export async function updateSettings(db: Db, actor: SessionUser, streamerId: string, patch: SettingsPatch, ipHash: string | null) {
  const keys = Object.keys(patch) as Array<keyof SettingsPatch>;
  if (!keys.length) return getSettings(db, streamerId);
  return db.tx(async (q) => {
    const before = await getSettings(q, streamerId);
    const merged = { ...before, ...patch };
    if (merged.max_points_per_message < merged.min_points_per_message) throw Errors.validation('Maximum points per message must be ≥ the minimum');
    if (merged.donation_max_cents < merged.donation_min_cents) throw Errors.validation('Maximum donation must be ≥ the minimum');
    if (patch.blocked_words) patch.blocked_words = [...new Set(patch.blocked_words.map((w) => w.toLowerCase()))];
    if (patch.announce_types) patch.announce_types = [...new Set(patch.announce_types)];
    for (const k of ['announce_template_voice', 'announce_template_mp3', 'announce_template_donation', 'announce_template_sound'] as const) {
      if (patch[k] !== undefined) {
        const t = sanitizeTemplate(patch[k]!);
        if (!t) throw Errors.validation('Announcement templates must contain speakable text', { field: k });
        patch[k] = t;
      }
    }

    const sets = keys.map((k, i) => `${k} = $${i + 2}`); // keys are validated by the strict schema above
    const after = await one<StreamerSettings>(
      q,
      `UPDATE streamer_settings SET ${sets.join(', ')}, updated_at = now() WHERE streamer_id = $1 RETURNING *`,
      [streamerId, ...keys.map((k) => patch[k])],
    );
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after![k])) changes[k] = { from: before[k], to: after![k] };
    // Anything that changes the generated speech invalidates the announcement cache.
    if (Object.keys(changes).some((k) => AUDIO_AFFECTING.has(k))) {
      await q.query('UPDATE streamer_settings SET announce_version = announce_version + 1 WHERE streamer_id = $1', [streamerId]);
      await q.query('DELETE FROM announcement_cache WHERE streamer_id = $1', [streamerId]);
      await q.query(
        `UPDATE playback_queue SET announcement_status = 'PENDING', announcement_audio_file_id = NULL, announcement_text = NULL, announcement_generated_at = NULL
          WHERE streamer_id = $1 AND status = 'QUEUED' AND announcement_status IN ('READY','FAILED')`,
        [streamerId],
      );
      after!.announce_version += 1;
    }
    if (Object.keys(changes).length) {
      await audit(q, { actorUserId: actor.id, streamerId, action: 'settings.updated', entityType: 'streamer_settings', entityId: streamerId, metadata: { changes }, ipHash });
    }
    return after!;
  });
}

export const profileSchema = z
  .object({
    display_name: z.string().trim().min(2).max(40),
    bio: z.string().max(500),
    brand_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  })
  .partial()
  .strict();

export async function updateProfile(db: Db, actor: SessionUser, streamerId: string, patch: z.infer<typeof profileSchema>) {
  const values = {
    display_name: patch.display_name !== undefined ? cleanText(patch.display_name, 40) : undefined,
    bio: patch.bio !== undefined ? cleanText(patch.bio, 500) : undefined,
    brand_color: patch.brand_color,
  };
  const row = await one<StreamerRow>(
    db,
    `UPDATE streamers SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), brand_color = COALESCE($4, brand_color), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [streamerId, values.display_name ?? null, values.bio ?? null, values.brand_color ?? null],
  );
  await audit(db, { actorUserId: actor.id, streamerId, action: 'profile.updated', entityType: 'streamer', entityId: streamerId, metadata: { fields: Object.keys(patch) } });
  return row!;
}

export async function rotateOverlayKey(db: Db, actor: SessionUser, streamerId: string) {
  const row = await one<{ overlay_key: string }>(db, 'UPDATE streamers SET overlay_key = $2, updated_at = now() WHERE id = $1 RETURNING overlay_key', [streamerId, randomToken(24)]);
  await audit(db, { actorUserId: actor.id, streamerId, action: 'overlay.key_rotated', entityType: 'streamer', entityId: streamerId });
  return row!.overlay_key;
}

/** Public, non-sensitive channel info (no overlay key, no internal limits). */
export function publicStreamer(s: StreamerRow, settings?: StreamerSettings) {
  return {
    id: s.id,
    slug: s.slug,
    displayName: s.display_name,
    bio: s.bio,
    avatarUrl: s.avatar_url,
    bannerUrl: s.banner_url,
    isLive: s.is_live,
    liveTitle: s.live_title,
    brandColor: s.brand_color,
    kickUrl: `https://kick.com/${encodeURIComponent(s.slug)}`,
    ...(settings && {
      features: {
        text: settings.text_enabled,
        voice: settings.voice_enabled,
        mp3: settings.mp3_enabled,
        sounds: settings.sounds_enabled,
        donations: settings.donations_enabled,
        donationVoice: settings.donation_voice_enabled,
      },
      pricing: {
        text: settings.price_text,
        voice: settings.price_voice,
        mp3: settings.price_mp3,
        priority: settings.price_priority,
        minPerMessage: settings.min_points_per_message,
        maxPerMessage: settings.max_points_per_message,
        freeTextPerDay: settings.free_text_per_day,
      },
      limits: {
        maxAudioSeconds: settings.max_audio_seconds,
        maxFileBytes: settings.max_file_bytes,
        cooldownSeconds: settings.cooldown_seconds,
        dailyMessageLimit: settings.daily_message_limit,
      },
      donations: { minCents: settings.donation_min_cents, maxCents: settings.donation_max_cents },
      approvalMode: settings.approval_mode,
    }),
  };
}
