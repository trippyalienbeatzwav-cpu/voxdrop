-- VoxDrop initial schema (PostgreSQL 15+; also runs on PGlite for development/tests)

CREATE TYPE user_role AS ENUM ('VIEWER', 'STREAMER', 'MODERATOR', 'ADMIN');
CREATE TYPE account_status AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE message_type AS ENUM ('TEXT', 'VOICE', 'MP3', 'SOUND');
CREATE TYPE message_status AS ENUM ('PENDING', 'APPROVED', 'QUEUED', 'PLAYING', 'PLAYED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE points_tx_type AS ENUM ('POINTS_EARNED', 'POINTS_SPENT', 'POINTS_PURCHASED', 'POINTS_REWARDED', 'POINTS_REFUNDED', 'POINTS_ADJUSTED', 'POINTS_EXPIRED');

-- ── Identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL,
  display_name     text NOT NULL,
  avatar_url       text,
  bio              text NOT NULL DEFAULT '',
  role             user_role NOT NULL DEFAULT 'VIEWER',
  status           account_status NOT NULL DEFAULT 'ACTIVE',
  suspended_reason text,
  reduced_motion   boolean NOT NULL DEFAULT false,
  last_login_at    timestamptz,
  last_daily_bonus date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX users_username_lower_uq ON users (lower(username)) WHERE deleted_at IS NULL;

CREATE TABLE kick_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kick_user_id       text NOT NULL UNIQUE,
  kick_username      text NOT NULL,
  profile_picture    text,
  -- OAuth tokens are only kept for streamers (needed for channel + event APIs),
  -- encrypted at rest with AES-256-GCM.
  access_token_enc   text,
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text NOT NULL DEFAULT '',
  tokens_revoked_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  csrf_token    text NOT NULL,
  ip_hash       text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE oauth_states (
  state_hash     text PRIMARY KEY,
  browser_hash   text NOT NULL,
  code_verifier  text NOT NULL,
  intent         text NOT NULL CHECK (intent IN ('login', 'connect_channel')),
  redirect_after text NOT NULL DEFAULT '/dashboard',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz
);

-- ── Streamers ───────────────────────────────────────────────────────────────
CREATE TABLE streamers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug                      text NOT NULL,
  display_name              text NOT NULL,
  bio                       text NOT NULL DEFAULT '',
  avatar_url                text,
  banner_url                text,
  kick_broadcaster_user_id  text UNIQUE,
  is_live                   boolean NOT NULL DEFAULT false,
  live_title                text,
  live_changed_at           timestamptz,
  brand_color               text NOT NULL DEFAULT '#C6FF3D' CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  overlay_key               text NOT NULL,
  queue_paused              boolean NOT NULL DEFAULT false,
  kick_events_subscribed_at timestamptz,
  status                    account_status NOT NULL DEFAULT 'ACTIVE',
  suspended_reason          text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);
CREATE UNIQUE INDEX streamers_slug_uq ON streamers (lower(slug)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX streamers_overlay_key_uq ON streamers (overlay_key);

CREATE TABLE streamer_moderators (
  streamer_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (streamer_id, user_id)
);
CREATE INDEX streamer_moderators_user_idx ON streamer_moderators (user_id);

CREATE TABLE streamer_settings (
  streamer_id               uuid PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
  -- Features
  text_enabled              boolean NOT NULL DEFAULT true,
  voice_enabled             boolean NOT NULL DEFAULT true,
  mp3_enabled               boolean NOT NULL DEFAULT true,
  sounds_enabled            boolean NOT NULL DEFAULT true,
  donations_enabled         boolean NOT NULL DEFAULT true,
  -- Audio limits
  max_audio_seconds         integer NOT NULL DEFAULT 60 CHECK (max_audio_seconds BETWEEN 3 AND 300),
  max_file_bytes            integer NOT NULL DEFAULT 8388608 CHECK (max_file_bytes BETWEEN 65536 AND 26214400),
  -- Pricing (points)
  price_text                integer NOT NULL DEFAULT 50 CHECK (price_text >= 0),
  price_voice               integer NOT NULL DEFAULT 150 CHECK (price_voice >= 0),
  price_mp3                 integer NOT NULL DEFAULT 250 CHECK (price_mp3 >= 0),
  price_priority            integer NOT NULL DEFAULT 200 CHECK (price_priority >= 0),
  sound_price_default       integer NOT NULL DEFAULT 100 CHECK (sound_price_default >= 0),
  min_points_per_message    integer NOT NULL DEFAULT 0 CHECK (min_points_per_message >= 0),
  max_points_per_message    integer NOT NULL DEFAULT 100000 CHECK (max_points_per_message > 0),
  free_text_per_day         integer NOT NULL DEFAULT 0 CHECK (free_text_per_day >= 0),
  -- Anti-spam
  cooldown_seconds          integer NOT NULL DEFAULT 30 CHECK (cooldown_seconds >= 0),
  daily_message_limit       integer NOT NULL DEFAULT 20 CHECK (daily_message_limit >= 0),
  queue_limit               integer NOT NULL DEFAULT 50 CHECK (queue_limit > 0),
  blocked_words             text[] NOT NULL DEFAULT '{}',
  approval_mode             text NOT NULL DEFAULT 'MANUAL' CHECK (approval_mode IN ('AUTO', 'MANUAL')),
  auto_reject_blocked_words boolean NOT NULL DEFAULT true,
  moderators_can_approve    boolean NOT NULL DEFAULT true,
  refund_on_reject          boolean NOT NULL DEFAULT true,
  message_expiry_minutes    integer NOT NULL DEFAULT 180 CHECK (message_expiry_minutes BETWEEN 5 AND 10080),
  -- Rewards
  rewards_enabled           boolean NOT NULL DEFAULT true,
  sub_reward_points         integer NOT NULL DEFAULT 500 CHECK (sub_reward_points >= 0),
  resub_reward_points       integer NOT NULL DEFAULT 300 CHECK (resub_reward_points >= 0),
  gift_reward_points        integer NOT NULL DEFAULT 750 CHECK (gift_reward_points >= 0),
  multi_gift_threshold      integer NOT NULL DEFAULT 5 CHECK (multi_gift_threshold >= 2),
  multi_gift_bonus_points   integer NOT NULL DEFAULT 1000 CHECK (multi_gift_bonus_points >= 0),
  giftee_reward_points      integer NOT NULL DEFAULT 100 CHECK (giftee_reward_points >= 0),
  follow_reward_points      integer NOT NULL DEFAULT 0 CHECK (follow_reward_points >= 0),
  reward_daily_cap_per_user integer NOT NULL DEFAULT 20000 CHECK (reward_daily_cap_per_user >= 0),
  max_gifts_rewarded_per_event integer NOT NULL DEFAULT 50 CHECK (max_gifts_rewarded_per_event >= 1),
  streamer_grant_daily_cap  integer NOT NULL DEFAULT 5000 CHECK (streamer_grant_daily_cap >= 0),
  -- Donations (money, minor units)
  donation_min_cents        integer NOT NULL DEFAULT 100 CHECK (donation_min_cents >= 50),
  donation_max_cents        integer NOT NULL DEFAULT 50000 CHECK (donation_max_cents >= donation_min_cents),
  donation_voice_enabled    boolean NOT NULL DEFAULT true,
  -- Playback & alerts
  auto_queue_approved       boolean NOT NULL DEFAULT true,
  auto_play                 boolean NOT NULL DEFAULT true,
  playback_gap_ms           integer NOT NULL DEFAULT 1500 CHECK (playback_gap_ms BETWEEN 0 AND 30000),
  playback_volume           integer NOT NULL DEFAULT 80 CHECK (playback_volume BETWEEN 0 AND 100),
  alert_duration_ms         integer NOT NULL DEFAULT 6000 CHECK (alert_duration_ms BETWEEN 1000 AND 30000),
  alert_style               text NOT NULL DEFAULT 'slide' CHECK (alert_style IN ('slide', 'pop', 'minimal')),
  overlay_show_avatar       boolean NOT NULL DEFAULT true,
  overlay_show_points       boolean NOT NULL DEFAULT true,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (max_points_per_message >= min_points_per_message)
);

-- ── Audio ───────────────────────────────────────────────────────────────────
CREATE TABLE audio_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          uuid NOT NULL REFERENCES users(id),
  streamer_id       uuid REFERENCES streamers(id),
  purpose           text NOT NULL CHECK (purpose IN ('MESSAGE', 'SOUND', 'DONATION')),
  storage_key       text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  mime_type         text NOT NULL CHECK (mime_type IN ('audio/mpeg', 'audio/wav')),
  container         text NOT NULL CHECK (container IN ('mp3', 'wav')),
  size_bytes        integer NOT NULL CHECK (size_bytes > 0),
  duration_ms       integer NOT NULL CHECK (duration_ms > 0),
  sample_rate       integer NOT NULL,
  channels          integer NOT NULL,
  sha256            text NOT NULL,
  waveform          jsonb NOT NULL DEFAULT '[]',
  normalized_gain_db real,
  scan_status       text NOT NULL CHECK (scan_status IN ('CLEAN', 'SKIPPED')),
  attached_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX audio_files_owner_idx ON audio_files (owner_id, created_at DESC);

CREATE TABLE audio_processing_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_file_id uuid REFERENCES audio_files(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('VALIDATE_AND_PROCESS')),
  status        text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  attempts      integer NOT NULL DEFAULT 1,
  error_code    text,
  error         text,
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX audio_jobs_status_idx ON audio_processing_jobs (status, created_at DESC);

-- ── Sounds ──────────────────────────────────────────────────────────────────
CREATE TABLE sound_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE sounds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id      uuid NOT NULL REFERENCES streamers(id),
  category_id      uuid NOT NULL REFERENCES sound_categories(id),
  audio_file_id    uuid NOT NULL REFERENCES audio_files(id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  icon             text NOT NULL DEFAULT 'volume-2',
  color            text NOT NULL DEFAULT '#C6FF3D' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  duration_ms      integer NOT NULL,
  price_points     integer NOT NULL CHECK (price_points >= 0),
  cooldown_seconds integer NOT NULL DEFAULT 30 CHECK (cooldown_seconds >= 0),
  daily_limit      integer NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
  sort_order       integer NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX sounds_name_uq ON sounds (streamer_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX sounds_streamer_idx ON sounds (streamer_id) WHERE deleted_at IS NULL;

-- ── Money: payments / donations / refunds (never mixed with points) ─────────
CREATE TABLE points_packages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  points      integer NOT NULL CHECK (points > 0),
  bonus_label text,
  price_cents integer NOT NULL CHECK (price_cents >= 50),
  currency    text NOT NULL DEFAULT 'usd',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  provider            text NOT NULL CHECK (provider IN ('stripe', 'mock')),
  provider_session_id text UNIQUE,
  provider_payment_id text,
  purpose             text NOT NULL CHECK (purpose IN ('DONATION', 'POINTS_PURCHASE')),
  amount_cents        integer NOT NULL CHECK (amount_cents > 0),
  currency            text NOT NULL,
  status              text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REFUNDED')),
  points_package_id   uuid REFERENCES points_packages(id),
  points_amount       integer,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);

CREATE TABLE donations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id   uuid NOT NULL REFERENCES streamers(id),
  donor_id      uuid NOT NULL REFERENCES users(id),
  payment_id    uuid NOT NULL UNIQUE REFERENCES payments(id),
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  currency      text NOT NULL,
  message       text NOT NULL DEFAULT '' CHECK (char_length(message) <= 300),
  audio_file_id uuid REFERENCES audio_files(id),
  message_id    uuid,
  is_anonymous  boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  refunded_at   timestamptz
);
CREATE INDEX donations_streamer_idx ON donations (streamer_id, created_at DESC);
CREATE INDEX donations_donor_idx ON donations (donor_id, created_at DESC);

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         uuid NOT NULL REFERENCES payments(id),
  amount_cents       integer NOT NULL CHECK (amount_cents > 0),
  provider_refund_id text UNIQUE,
  reason             text NOT NULL DEFAULT '',
  status             text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── Messages & playback ─────────────────────────────────────────────────────
CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id      uuid NOT NULL REFERENCES streamers(id),
  sender_id        uuid NOT NULL REFERENCES users(id),
  type             message_type NOT NULL,
  text_content     text NOT NULL DEFAULT '' CHECK (char_length(text_content) <= 300),
  audio_file_id    uuid REFERENCES audio_files(id),
  sound_id         uuid REFERENCES sounds(id),
  donation_id      uuid REFERENCES donations(id),
  points_spent     integer NOT NULL DEFAULT 0 CHECK (points_spent >= 0),
  bonus_points     integer NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  is_priority      boolean NOT NULL DEFAULT false,
  status           message_status NOT NULL DEFAULT 'PENDING',
  flagged          boolean NOT NULL DEFAULT false,
  flag_reason      text,
  rejection_reason text,
  moderated_by     uuid REFERENCES users(id),
  moderated_at     timestamptz,
  idempotency_key  text,
  played_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK ((type IN ('VOICE', 'MP3') AND audio_file_id IS NOT NULL) OR type NOT IN ('VOICE', 'MP3')),
  CHECK ((type = 'SOUND' AND sound_id IS NOT NULL) OR type <> 'SOUND')
);
CREATE UNIQUE INDEX messages_idem_uq ON messages (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_streamer_status_idx ON messages (streamer_id, status, created_at DESC);
CREATE INDEX messages_sender_idx ON messages (sender_id, created_at DESC);
CREATE INDEX messages_streamer_sender_day_idx ON messages (streamer_id, sender_id, created_at DESC);
ALTER TABLE donations ADD CONSTRAINT donations_message_fk FOREIGN KEY (message_id) REFERENCES messages(id);

CREATE TABLE playback_queue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id uuid NOT NULL REFERENCES streamers(id),
  message_id  uuid NOT NULL UNIQUE REFERENCES messages(id),
  position    double precision NOT NULL,
  is_priority boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'PLAYING', 'PLAYED', 'SKIPPED', 'REMOVED')),
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
-- Database-level guarantee that a streamer never has two items playing at once.
CREATE UNIQUE INDEX playback_one_playing_uq ON playback_queue (streamer_id) WHERE status = 'PLAYING';
CREATE INDEX playback_queue_order_idx ON playback_queue (streamer_id, status, is_priority DESC, position);

CREATE TABLE sound_usage (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sound_id     uuid NOT NULL REFERENCES sounds(id),
  streamer_id  uuid NOT NULL REFERENCES streamers(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  message_id   uuid REFERENCES messages(id),
  points_spent integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sound_usage_sound_idx ON sound_usage (sound_id, created_at DESC);
CREATE INDEX sound_usage_user_idx ON sound_usage (user_id, created_at DESC);

-- ── Points ledger ───────────────────────────────────────────────────────────
CREATE TABLE points_accounts (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance         integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned integer NOT NULL DEFAULT 0,
  lifetime_spent  integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE points_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  streamer_id     uuid REFERENCES streamers(id),
  type            points_tx_type NOT NULL,
  amount          integer NOT NULL CHECK (amount <> 0),
  balance_before  integer NOT NULL,
  balance_after   integer NOT NULL CHECK (balance_after >= 0),
  reference_type  text,
  reference_id    text,
  description     text NOT NULL,
  idempotency_key text UNIQUE,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (balance_after = balance_before + amount)
);
CREATE INDEX points_tx_user_idx ON points_transactions (user_id, created_at DESC);
CREATE INDEX points_tx_streamer_idx ON points_transactions (streamer_id, created_at DESC);

-- ── Kick events: subscriptions / gifts / webhooks ───────────────────────────
CREATE TABLE webhook_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL CHECK (provider IN ('kick', 'stripe', 'mock')),
  event_id       text NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED')),
  error          text,
  attempts       integer NOT NULL DEFAULT 0,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_status_idx ON webhook_events (status, received_at DESC);

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id          uuid NOT NULL REFERENCES streamers(id),
  webhook_event_id     uuid NOT NULL REFERENCES webhook_events(id),
  kind                 text NOT NULL CHECK (kind IN ('NEW', 'RENEWAL', 'GIFTED')),
  kick_user_id         text NOT NULL,
  kick_username        text NOT NULL,
  user_id              uuid REFERENCES users(id),
  duration_months      integer NOT NULL DEFAULT 1,
  gift_subscription_id uuid,
  reward_points        integer NOT NULL DEFAULT 0,
  reward_status        text NOT NULL CHECK (reward_status IN ('AWARDED', 'PENDING_LINK', 'CAPPED', 'DISABLED', 'NONE')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_event_id, kick_user_id)
);
CREATE INDEX subscriptions_pending_idx ON subscriptions (kick_user_id) WHERE reward_status = 'PENDING_LINK';
CREATE INDEX subscriptions_streamer_idx ON subscriptions (streamer_id, created_at DESC);

CREATE TABLE gift_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id          uuid NOT NULL REFERENCES streamers(id),
  webhook_event_id     uuid NOT NULL UNIQUE REFERENCES webhook_events(id),
  gifter_kick_user_id  text,
  gifter_username      text,
  gifter_user_id       uuid REFERENCES users(id),
  is_anonymous         boolean NOT NULL DEFAULT false,
  gift_count           integer NOT NULL CHECK (gift_count > 0),
  reward_points        integer NOT NULL DEFAULT 0,
  reward_status        text NOT NULL CHECK (reward_status IN ('AWARDED', 'PENDING_LINK', 'CAPPED', 'DISABLED', 'NONE')),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_subs_pending_idx ON gift_subscriptions (gifter_kick_user_id) WHERE reward_status = 'PENDING_LINK';
CREATE INDEX gift_subs_streamer_idx ON gift_subscriptions (streamer_id, created_at DESC);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_gift_fk FOREIGN KEY (gift_subscription_id) REFERENCES gift_subscriptions(id);

CREATE TABLE follows_rewarded (
  streamer_id  uuid NOT NULL REFERENCES streamers(id),
  kick_user_id text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (streamer_id, kick_user_id)
);

-- ── Moderation ──────────────────────────────────────────────────────────────
CREATE TABLE bans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id uuid REFERENCES streamers(id),  -- NULL = platform-wide (admin)
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('BAN', 'MUTE')),
  reason      text NOT NULL DEFAULT '',
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  lifted_at   timestamptz,
  lifted_by   uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX bans_active_uq ON bans (COALESCE(streamer_id, '00000000-0000-0000-0000-000000000000'::uuid), user_id, kind) WHERE lifted_at IS NULL;
CREATE INDEX bans_user_idx ON bans (user_id);

CREATE TABLE moderation_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id    uuid REFERENCES streamers(id),
  actor_id       uuid NOT NULL REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  message_id     uuid REFERENCES messages(id),
  action         text NOT NULL,
  reason         text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_streamer_idx ON moderation_actions (streamer_id, created_at DESC);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  target_type text NOT NULL CHECK (target_type IN ('MESSAGE', 'USER', 'SOUND', 'STREAMER')),
  target_id   uuid NOT NULL,
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  resolution  text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);

-- ── Notifications & audit ───────────────────────────────────────────────────
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id),
  streamer_id   uuid REFERENCES streamers(id),
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  ip_hash       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_streamer_idx ON audit_logs (streamer_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

-- Immutability: the ledger and the audit log are append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER points_transactions_immutable BEFORE UPDATE OR DELETE ON points_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
