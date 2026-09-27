-- Automatic playback delay is one of 0 / 2 / 5 / 10 seconds (spec). The old
-- default (1.5 s) is not one of those options, so move it to 2 s.
ALTER TABLE streamer_settings ALTER COLUMN playback_gap_ms SET DEFAULT 2000;
UPDATE streamer_settings SET playback_gap_ms = 2000 WHERE playback_gap_ms = 1500;
