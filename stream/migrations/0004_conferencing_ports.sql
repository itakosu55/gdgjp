-- Conferencing apps become 8-port, and the laptop transducers get catalogued.
--
-- `mic_in` / `spk_out` alone cannot express a screen share, so a presenter
-- playing a video from their own laptop — the case that closes a loop no echo
-- canceller can remove — was not writable. Screen-share audio is split from its
-- video for the same reason USB audio is two ports: "the video's sound is in
-- the room but not on the stream" is exactly that asymmetry, and one combined
-- port hides it.
--
-- The existing `mic_in` / `spk_out` keys are kept verbatim: documents, tests
-- and e2e fixtures already reference them, and renaming would be a data
-- migration for nothing. `internal_routing` stays `none` — a join reaches its
-- *meeting*, which is a transport space, never an internal route.

INSERT INTO device_models (id, maker, name, category, internal_routing, notes) VALUES
  ('mdl_seed_vdo',         NULL, 'VDO.Ninja',        'software_conferencing', 'none', 'ブラウザ経由の低遅延伝送。受信専用・送出専用の両方で使う'),
  ('mdl_seed_builtin_mic', NULL, 'PC 内蔵マイク',     'mic',                   'none', '端子がないので connector は none。会場の空間に結合する'),
  ('mdl_seed_builtin_spk', NULL, 'PC 内蔵スピーカー', 'speaker',               'none', '同上。登壇者の私物 PC を構成に載せるために要る');

INSERT INTO device_model_ports (id, model_id, key, label, direction, signal, connector, level, channels, phantom, bus_id, sort_order) VALUES
  -- Google Meet — the two existing ports keep sort_order 1 and 2.
  ('prt_meet_cam_in',     'mdl_seed_meet', 'cam_video_in',    '送信する映像',           'in',  'video',         'none', NULL, 1, 'none', NULL, 3),
  ('prt_meet_shr_a_in',   'mdl_seed_meet', 'share_audio_in',  '画面共有で送る音声',      'in',  'audio_digital', 'none', NULL, 2, 'none', NULL, 4),
  ('prt_meet_shr_v_in',   'mdl_seed_meet', 'share_video_in',  '画面共有で送る映像',      'in',  'video',         'none', NULL, 1, 'none', NULL, 5),
  ('prt_meet_cam_out',    'mdl_seed_meet', 'cam_video_out',   'リモート参加者の映像',    'out', 'video',         'none', NULL, 1, 'none', NULL, 6),
  ('prt_meet_shr_a_out',  'mdl_seed_meet', 'share_audio_out', 'リモート画面共有の音声',  'out', 'audio_digital', 'none', NULL, 2, 'none', NULL, 7),
  ('prt_meet_shr_v_out',  'mdl_seed_meet', 'share_video_out', 'リモート画面共有の映像',  'out', 'video',         'none', NULL, 1, 'none', NULL, 8),

  -- Zoom
  ('prt_zoom_cam_in',     'mdl_seed_zoom_app', 'cam_video_in',    '送信する映像',          'in',  'video',         'none', NULL, 1, 'none', NULL, 3),
  ('prt_zoom_shr_a_in',   'mdl_seed_zoom_app', 'share_audio_in',  '画面共有で送る音声',     'in',  'audio_digital', 'none', NULL, 2, 'none', NULL, 4),
  ('prt_zoom_shr_v_in',   'mdl_seed_zoom_app', 'share_video_in',  '画面共有で送る映像',     'in',  'video',         'none', NULL, 1, 'none', NULL, 5),
  ('prt_zoom_cam_out',    'mdl_seed_zoom_app', 'cam_video_out',   'リモート参加者の映像',   'out', 'video',         'none', NULL, 1, 'none', NULL, 6),
  ('prt_zoom_shr_a_out',  'mdl_seed_zoom_app', 'share_audio_out', 'リモート画面共有の音声', 'out', 'audio_digital', 'none', NULL, 2, 'none', NULL, 7),
  ('prt_zoom_shr_v_out',  'mdl_seed_zoom_app', 'share_video_out', 'リモート画面共有の映像', 'out', 'video',         'none', NULL, 1, 'none', NULL, 8),

  -- VDO.Ninja
  ('prt_vdo_mic_in',      'mdl_seed_vdo', 'mic_in',          '送信する音声',           'in',  'audio_digital', 'none', NULL, 2, 'none', NULL, 1),
  ('prt_vdo_spk_out',     'mdl_seed_vdo', 'spk_out',         'リモート参加者の音声',    'out', 'audio_digital', 'none', NULL, 2, 'none', NULL, 2),
  ('prt_vdo_cam_in',      'mdl_seed_vdo', 'cam_video_in',    '送信する映像',           'in',  'video',         'none', NULL, 1, 'none', NULL, 3),
  ('prt_vdo_shr_a_in',    'mdl_seed_vdo', 'share_audio_in',  '画面共有で送る音声',      'in',  'audio_digital', 'none', NULL, 2, 'none', NULL, 4),
  ('prt_vdo_shr_v_in',    'mdl_seed_vdo', 'share_video_in',  '画面共有で送る映像',      'in',  'video',         'none', NULL, 1, 'none', NULL, 5),
  ('prt_vdo_cam_out',     'mdl_seed_vdo', 'cam_video_out',   'リモート参加者の映像',    'out', 'video',         'none', NULL, 1, 'none', NULL, 6),
  ('prt_vdo_shr_a_out',   'mdl_seed_vdo', 'share_audio_out', 'リモート画面共有の音声',  'out', 'audio_digital', 'none', NULL, 2, 'none', NULL, 7),
  ('prt_vdo_shr_v_out',   'mdl_seed_vdo', 'share_video_out', 'リモート画面共有の映像',  'out', 'video',         'none', NULL, 1, 'none', NULL, 8),

  -- Built-in transducers. No connector and no level: there is no jack to
  -- mismatch, and a `computer` has no space coupling of its own, so these are
  -- what let a presenter's own laptop touch the room at all.
  ('prt_builtin_mic_out', 'mdl_seed_builtin_mic', 'out', '内蔵マイク',      'out', 'audio_analog', 'none', NULL, 1, 'none', NULL, 1),
  ('prt_builtin_spk_in',  'mdl_seed_builtin_spk', 'in',  '内蔵スピーカー',  'in',  'audio_analog', 'none', NULL, 2, 'none', NULL, 1);
