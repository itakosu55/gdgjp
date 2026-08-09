-- A port can be a template, and the setup decides how many of it there are.
--
-- OBS's audio mixer has one channel strip per source, and the sources are
-- chosen on the day. Modelling it as a single 音声ソース port made the strip
-- count permanently 1, which is not a granularity complaint: the standard
-- hybrid layout — hall mics muted on monitor, the meeting monitored and sent to
-- the room PA — could not be written at all, and the linter's offered fix for
-- the resulting critical was to cut the remote participants out of the room.
-- See docs/260805_stream_av_designer.md §12.1–12.3.
--
-- The catalog stays the authority on what an OBS *is*: direction, signal,
-- connector, couples and origin are all inherited from the template, and a
-- setup may only say how many and what each one is called.

ALTER TABLE device_model_ports ADD COLUMN expandable INTEGER NOT NULL DEFAULT 0;

-- Two ports that are one source (§12.4). A browser source has a picture and a
-- sound; they stay two ports, because "the video is on the stream but its audio
-- is not" is the commonest browser-source accident and one merged port hides
-- it. What was missing was never fewer ports but the name of the pairing.
ALTER TABLE device_model_ports ADD COLUMN source_key TEXT;

-- An input that needs nothing upstream: BGM, a video file (§12.5). Seeded in a
-- later migration; the column lands here because it is the same idea — what a
-- port template can declare about itself.
ALTER TABLE device_model_ports ADD COLUMN origin INTEGER NOT NULL DEFAULT 0;

-- OBS's two fixed inputs become templates. The row ids are kept, so
-- `device_model_default_routes` keeps pointing at them and 音声ソース → PROGRAM
-- survives as the default every instance inherits.
UPDATE device_model_ports
  SET key = 'audio_src', label = '音声ソース', expandable = 1, sort_order = 1
  WHERE id = 'prt_obs_audio_in';

UPDATE device_model_ports
  SET key = 'video_src', label = '映像ソース', expandable = 1, sort_order = 2
  WHERE id = 'prt_obs_video_in';

INSERT INTO device_model_ports
  (id, model_id, key, label, direction, signal, connector, level, channels, phantom, bus_id, couples, expandable, source_key, origin, sort_order)
VALUES
  ('prt_obs_browser_audio', 'mdl_seed_obs', 'browser_audio', 'ブラウザ音声', 'in', 'audio_digital', 'none', NULL, 2, 'none', NULL, NULL, 1, 'browser', 0, 3),
  ('prt_obs_browser_video', 'mdl_seed_obs', 'browser_video', 'ブラウザ映像', 'in', 'video',         'none', NULL, 1, 'none', NULL, NULL, 1, 'browser', 0, 4);

-- The outputs move down so the sources read first, the way the mixer window
-- does. Instances expand in the template's place, so this is also the order a
-- node's jacks appear in the diagram and the routing matrix.
UPDATE device_model_ports SET sort_order = 5 WHERE id = 'prt_obs_stream';
UPDATE device_model_ports SET sort_order = 6 WHERE id = 'prt_obs_prog_video';
UPDATE device_model_ports SET sort_order = 7 WHERE id = 'prt_obs_monitor';

-- A browser source is one source, so it gets one default: both halves on
-- PROGRAM. Their instances are created together and carry one `sourceId`.
INSERT INTO device_model_default_routes (model_id, in_port_id, bus_id)
VALUES
  ('mdl_seed_obs', 'prt_obs_browser_audio', 'bus_obs_program'),
  ('mdl_seed_obs', 'prt_obs_browser_video', 'bus_obs_program');
