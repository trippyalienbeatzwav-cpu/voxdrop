-- Streamer onboarding, split OBS overlays + alerts, points-based priority queue.
--
-- Naming note: the existing `streamers` table is the streamer profile (one optional profile
-- per user; users/kick_accounts are the single identity), `subscriptions` /
-- `gift_subscriptions` / `donations` are the subscription / gift-sub / donation event
-- records, `messages` are the audio messages and `playback_queue` doubles as the
-- playback log. New tables below cover the rest.

-- ── Points ledger: priority purchases are their own transaction type ─────────
ALTER TYPE points_tx_type ADD VALUE IF NOT EXISTS 'POINTS_SPENT_PRIORITY';
ALTER TABLE points_transactions ADD COLUMN priority_tier text;

-- ── OAuth: one-step "sign up as a streamer" intent ─────────────────────────
ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_intent_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_intent_check CHECK (intent IN ('login', 'connect_channel', 'streamer_signup'));

-- ── Priority queue ─────────────────────────────────────────────────────────
CREATE TABLE priority_settings (
  streamer_id                uuid PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
  enabled                    boolean NOT NULL DEFAULT true,
  points_weight              real    NOT NULL DEFAULT 1.0 CHECK (points_weight BETWEEN 0 AND 100),
  waiting_weight             real    NOT NULL DEFAULT 1.5 CHECK (waiting_weight BETWEEN 0 AND 100),
  -- Hard anti-starvation guarantee: anything waiting this long jumps ahead of all scored items.
  starvation_cap_seconds     integer NOT NULL DEFAULT 600 CHECK (starvation_cap_seconds BETWEEN 30 AND 86400),
  max_messages_per_viewer    integer NOT NULL DEFAULT 3 CHECK (max_messages_per_viewer BETWEEN 1 AND 100),
  refund_priority_on_reject  boolean NOT NULL DEFAULT true,
  allow_vip_interrupt        boolean NOT NULL DEFAULT false,
  default_tier               text    NOT NULL DEFAULT 'NORMAL' CHECK (default_tier IN ('NORMAL', 'PRIORITY', 'HIGH', 'VIP')),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE priority_tiers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id      uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  tier             text NOT NULL CHECK (tier IN ('NORMAL', 'PRIORITY', 'HIGH', 'VIP')),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  min_points       integer NOT NULL CHECK (min_points BETWEEN 0 AND 10000000),
  multiplier       real NOT NULL CHECK (multiplier BETWEEN 0.1 AND 100),
  color            text NOT NULL DEFAULT '#A3ACBB' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  icon             text NOT NULL DEFAULT 'circle',
  cooldown_seconds integer NOT NULL DEFAULT 0 CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  daily_limit      integer NOT NULL DEFAULT 0 CHECK (daily_limit BETWEEN 0 AND 1000),
  is_active        boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (streamer_id, tier)
);

ALTER TABLE messages
  ADD COLUMN priority_tier   text NOT NULL DEFAULT 'NORMAL' CHECK (priority_tier IN ('NORMAL', 'PRIORITY', 'HIGH', 'VIP')),
  ADD COLUMN priority_points integer NOT NULL DEFAULT 0 CHECK (priority_points >= 0);
CREATE INDEX messages_tier_usage_idx ON messages (sender_id, streamer_id, priority_tier, created_at DESC);

ALTER TABLE playback_queue
  ADD COLUMN priority_tier text NOT NULL DEFAULT 'NORMAL',
  -- Manual order set by the streamer (drag-and-drop / play now); NULL = automatic priority order.
  ADD COLUMN pinned_rank   integer;

-- ── Alerts ─────────────────────────────────────────────────────────────────
CREATE TABLE streamer_alert_settings (
  streamer_id       uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('subscription', 'gift_sub', 'donation')),
  enabled           boolean NOT NULL DEFAULT true,
  template          text NOT NULL CHECK (char_length(template) BETWEEN 1 AND 120),
  custom_message    text NOT NULL DEFAULT '' CHECK (char_length(custom_message) <= 160),
  show_avatar       boolean NOT NULL DEFAULT true,
  show_message      boolean NOT NULL DEFAULT true,
  animation         text NOT NULL DEFAULT 'slide' CHECK (animation IN ('slide', 'pop', 'fade', 'bounce')),
  position          text NOT NULL DEFAULT 'top' CHECK (position IN ('top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right')),
  duration_ms       integer NOT NULL DEFAULT 7000 CHECK (duration_ms BETWEEN 2000 AND 60000),
  sound_id          uuid REFERENCES sounds(id) ON DELETE SET NULL,
  volume            integer NOT NULL DEFAULT 80 CHECK (volume BETWEEN 0 AND 100),
  tts_enabled       boolean NOT NULL DEFAULT false,
  tts_read_message  boolean NOT NULL DEFAULT false,
  min_amount_cents  integer NOT NULL DEFAULT 0 CHECK (min_amount_cents >= 0),
  accent_color      text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (streamer_id, kind)
);

CREATE TABLE alert_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id       uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('subscription', 'gift_sub', 'donation')),
  source_type       text NOT NULL CHECK (source_type IN ('subscription', 'gift_subscription', 'donation', 'test')),
  source_id         text NOT NULL,
  is_test           boolean NOT NULL DEFAULT false,
  payload           jsonb NOT NULL,
  tts_audio_file_id uuid REFERENCES audio_files(id),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SHOWN', 'COMPLETED', 'FAILED', 'SKIPPED')),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  shown_at          timestamptz,
  completed_at      timestamptz,
  -- Idempotency: one alert per underlying verified event, even if the webhook is redelivered.
  UNIQUE (kind, source_type, source_id)
);
CREATE INDEX alert_events_streamer_idx ON alert_events (streamer_id, created_at DESC);

-- ── Per-overlay secret tokens (OBS Browser Source URLs) ────────────────────
CREATE TABLE overlay_tokens (
  streamer_id  uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('audio', 'subscription', 'gift_sub', 'donation')),
  token_hash   text NOT NULL UNIQUE,
  token_enc    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  last_seen_at timestamptz,
  PRIMARY KEY (streamer_id, kind)
);

-- ── State machines enforced by the database ────────────────────────────────
CREATE FUNCTION enforce_message_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
  OR (OLD.status = 'APPROVED' AND NEW.status IN ('QUEUED', 'REJECTED', 'EXPIRED', 'CANCELLED'))
  OR (OLD.status = 'QUEUED'   AND NEW.status IN ('PLAYING', 'REJECTED', 'CANCELLED'))
  OR (OLD.status = 'PLAYING'  AND NEW.status IN ('PLAYED', 'CANCELLED', 'QUEUED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid message state transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0002';
END;
$$;
CREATE TRIGGER messages_state_machine BEFORE UPDATE OF status ON messages FOR EACH ROW EXECUTE FUNCTION enforce_message_transition();

CREATE FUNCTION enforce_queue_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status = 'QUEUED'  AND NEW.status IN ('PLAYING', 'SKIPPED', 'REMOVED'))
  OR (OLD.status = 'PLAYING' AND NEW.status IN ('PLAYED', 'SKIPPED', 'REMOVED', 'QUEUED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid queue state transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0002';
END;
$$;
CREATE TRIGGER playback_queue_state_machine BEFORE UPDATE OF status ON playback_queue FOR EACH ROW EXECUTE FUNCTION enforce_queue_transition();
