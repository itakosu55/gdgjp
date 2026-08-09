-- A source that needs nothing upstream: BGM, an opening video (§12.5).
--
-- Every signal the graph knew began at a cable or in a room, so playback from
-- the broadcast software was not merely awkward to write down — it was a kind
-- of thing the model did not have. That is what `origin` names: an input port
-- that is a valid start for a reachability search.
--
-- It costs nothing beyond this seed now that 0007 exists. The catalog is still
-- the authority on what an OBS is; a setup only says how many videos there are
-- and what each one is called.

INSERT INTO device_model_ports
  (id, model_id, key, label, direction, signal, connector, level, channels, phantom, bus_id, couples, expandable, source_key, origin, sort_order)
VALUES
  ('prt_obs_media_audio', 'mdl_seed_obs', 'media_audio', 'メディア音声', 'in', 'audio_digital', 'none', NULL, 2, 'none', NULL, NULL, 1, 'media', 1, 5),
  ('prt_obs_media_video', 'mdl_seed_obs', 'media_video', 'メディア映像', 'in', 'video',         'none', NULL, 1, 'none', NULL, NULL, 1, 'media', 1, 6);

-- The outputs stay last: instances expand where their template stands, so this
-- is the order the mixer, the matrix and the diagram all read.
UPDATE device_model_ports SET sort_order = 7 WHERE id = 'prt_obs_stream';
UPDATE device_model_ports SET sort_order = 8 WHERE id = 'prt_obs_prog_video';
UPDATE device_model_ports SET sort_order = 9 WHERE id = 'prt_obs_monitor';

-- A video's picture and its sound are one source (`source_key = 'media'`) and
-- both begin on PROGRAM, the same default every other source of OBS carries.
-- Whether it also goes to MONITOR is the decision this whole step exists to
-- make visible: leave it off and only the room and the meeting miss the video.
INSERT INTO device_model_default_routes (model_id, in_port_id, bus_id)
VALUES
  ('mdl_seed_obs', 'prt_obs_media_audio', 'bus_obs_program'),
  ('mdl_seed_obs', 'prt_obs_media_video', 'bus_obs_program');
