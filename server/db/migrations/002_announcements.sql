-- Viewer name voice announcements.
-- The announcement is part of the existing playback queue item (one row =
-- announcement + viewer audio), so the two can never be separated or reordered.

ALTER TABLE audio_files DROP CONSTRAINT audio_files_purpose_check;
ALTER TABLE audio_files ADD CONSTRAINT audio_files_purpose_check CHECK (purpose IN ('MESSAGE', 'SOUND', 'DONATION', 'ANNOUNCEMENT'));

ALTER TABLE streamer_settings
  ADD COLUMN announce_enabled           boolean NOT NULL DEFAULT true,
  ADD COLUMN announce_types             text[]  NOT NULL DEFAULT '{VOICE,MP3,DONATION}',
  ADD COLUMN announce_voice             text    NOT NULL DEFAULT '',
  ADD COLUMN announce_locale            text    NOT NULL DEFAULT 'en-US' CHECK (announce_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  ADD COLUMN announce_speed             real    NOT NULL DEFAULT 1.0 CHECK (announce_speed BETWEEN 0.5 AND 2.0),
  ADD COLUMN announce_volume            integer NOT NULL DEFAULT 90 CHECK (announce_volume BETWEEN 0 AND 100),
  ADD COLUMN announce_template_voice    text    NOT NULL DEFAULT 'Voice message from {viewerName}' CHECK (char_length(announce_template_voice) BETWEEN 1 AND 120),
  ADD COLUMN announce_template_mp3      text    NOT NULL DEFAULT 'Audio message from {viewerName}' CHECK (char_length(announce_template_mp3) BETWEEN 1 AND 120),
  ADD COLUMN announce_template_donation text    NOT NULL DEFAULT 'Donation from {viewerName}' CHECK (char_length(announce_template_donation) BETWEEN 1 AND 120),
  ADD COLUMN announce_template_sound    text    NOT NULL DEFAULT '{viewerName} played a sound' CHECK (char_length(announce_template_sound) BETWEEN 1 AND 120),
  -- Bumped whenever any setting that changes the generated audio changes (cache invalidation).
  ADD COLUMN announce_version           integer NOT NULL DEFAULT 1;

-- PlaybackItem: `status` keeps its existing queue meaning (QUEUED/PLAYING/PLAYED/SKIPPED/REMOVED);
-- `phase` is the fine-grained playback state machine.
ALTER TABLE playback_queue
  ADD COLUMN phase                      text NOT NULL DEFAULT 'PENDING'
      CHECK (phase IN ('PENDING', 'ANNOUNCING', 'PLAYING_MESSAGE', 'COMPLETED', 'SKIPPED', 'FAILED')),
  ADD COLUMN viewer_name                text,
  ADD COLUMN announcement_status        text NOT NULL DEFAULT 'NONE'
      CHECK (announcement_status IN ('NONE', 'PENDING', 'READY', 'FAILED', 'PLAYED', 'SKIPPED')),
  ADD COLUMN announcement_text          text,
  ADD COLUMN announcement_audio_file_id uuid REFERENCES audio_files(id),
  ADD COLUMN announcement_cached        boolean,
  ADD COLUMN announcement_generated_at  timestamptz,
  ADD COLUMN announcement_started_at    timestamptz,
  ADD COLUMN announcement_finished_at   timestamptz,
  ADD COLUMN message_started_at         timestamptz,
  ADD COLUMN message_finished_at        timestamptz,
  ADD COLUMN error                      text;

UPDATE playback_queue SET phase = CASE status WHEN 'PLAYED' THEN 'COMPLETED' WHEN 'SKIPPED' THEN 'SKIPPED' WHEN 'REMOVED' THEN 'SKIPPED' ELSE 'PENDING' END;
CREATE INDEX playback_queue_log_idx ON playback_queue (streamer_id, finished_at DESC) WHERE finished_at IS NOT NULL;

-- Generated announcement audio, reused while streamer + viewer + name + voice settings are unchanged.
CREATE TABLE announcement_cache (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id   uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  cache_key     text NOT NULL UNIQUE,
  version       integer NOT NULL,
  spoken_text   text NOT NULL,
  audio_file_id uuid NOT NULL REFERENCES audio_files(id),
  hit_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcement_cache_streamer_idx ON announcement_cache (streamer_id, version);
