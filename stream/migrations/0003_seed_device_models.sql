-- Starter 型番カタログ.
--
-- The catalog is user-editable in D1, but an empty catalog means nobody can
-- register a device, and it also means a future AI proposal has nothing to
-- ground itself on. These are the models a GDG chapter actually turns up with.
-- `created_by` is NULL: they belong to nobody.

INSERT INTO device_models (id, maker, name, category, internal_routing, notes) VALUES
  ('mdl_seed_sm58',      'Shure',          'SM58',                 'mic',                   'none',        'ダイナミック。ファンタム不要'),
  ('mdl_seed_at2020',    'audio-technica', 'AT2020',               'mic',                   'none',        'コンデンサー。+48V 必須'),
  ('mdl_seed_headset',   NULL,             'ヘッドセットマイク',    'mic',                   'none',        '口元に近いので通常 isolated'),
  ('mdl_seed_lav',       NULL,             'ピンマイク (有線)',     'mic',                   'none',        NULL),
  ('mdl_seed_mg10xu',    'YAMAHA',         'MG10XU',               'mixer',                 'matrix',      'MAIN / AUX1 / USB の 3 バス'),
  ('mdl_seed_ag03',      'YAMAHA',         'AG03',                 'audio_interface',       'matrix',      'ループバックは USB バスへの経路として表現'),
  ('mdl_seed_speaker',   NULL,             'パワードスピーカー',     'speaker',               'none',        NULL),
  ('mdl_seed_headphone', NULL,             'ヘッドホン',            'headphone',             'none',        '空間に音を出さない'),
  ('mdl_seed_pc',        NULL,             'ノートPC (配信用)',     'computer',              'none',        'ソフトウェアのホスト'),
  ('mdl_seed_obs',       NULL,             'OBS Studio',           'software_broadcast',    'matrix',      'PROGRAM / MONITOR の 2 バス'),
  ('mdl_seed_meet',      'Google',         'Google Meet',          'software_conferencing', 'none',        '入力と出力は絶対に内部接続しない'),
  ('mdl_seed_zoom_app',  'Zoom',           'Zoom',                 'software_conferencing', 'none',        NULL),
  ('mdl_seed_camera',    NULL,             'ビデオカメラ (HDMI出力)','camera',                'none',        'クリーン出力の設定を忘れがち'),
  ('mdl_seed_camlink',   'Elgato',         'Cam Link 4K',          'capture',               'passthrough', NULL),
  ('mdl_seed_atem',      'Blackmagic',     'ATEM Mini',            'switcher',              'matrix',      'PROGRAM / USB(Webcam) の 2 バス'),
  ('mdl_seed_projector', NULL,             'プロジェクタ',          'display',               'none',        NULL),
  ('mdl_seed_di',        NULL,             'DI ボックス',           'di',                    'passthrough', NULL),
  ('mdl_seed_recorder',  'ZOOM',           'H1n',                  'recorder',              'none',        'バックアップ収録'),
  ('mdl_seed_house_pa',  NULL,             '会場常設 PA (内部不明)', 'blackbox',              'passthrough', '全入力が全出力に流れる前提で保守的に検査される');

INSERT INTO device_model_buses (id, model_id, key, label, kind, sort_order) VALUES
  ('bus_mg10xu_main',   'mdl_seed_mg10xu', 'main',    'MAIN',    'main',    1),
  ('bus_mg10xu_aux1',   'mdl_seed_mg10xu', 'aux1',    'AUX1',    'aux',     2),
  ('bus_mg10xu_usb',    'mdl_seed_mg10xu', 'usb',     'USB',     'usb',     3),
  ('bus_ag03_main',     'mdl_seed_ag03',   'main',    'MONITOR OUT', 'main', 1),
  ('bus_ag03_usb',      'mdl_seed_ag03',   'usb',     'USB',     'usb',     2),
  ('bus_ag03_phones',   'mdl_seed_ag03',   'phones',  'PHONES',  'monitor', 3),
  ('bus_obs_program',   'mdl_seed_obs',    'program', 'PROGRAM', 'main',    1),
  ('bus_obs_monitor',   'mdl_seed_obs',    'monitor', 'MONITOR', 'monitor', 2),
  ('bus_atem_program',  'mdl_seed_atem',   'program', 'PROGRAM', 'main',    1),
  ('bus_atem_usb',      'mdl_seed_atem',   'usb',     'USB (Webcam)', 'usb', 2);

INSERT INTO device_model_ports
  (id, model_id, key, label, direction, signal, connector, level, channels, phantom, bus_id, sort_order) VALUES
  -- mics
  ('prt_sm58_out',      'mdl_seed_sm58',      'out',    'OUT',     'out', 'audio_analog', 'xlr',      'mic',  1, 'none',       NULL, 1),
  ('prt_at2020_out',    'mdl_seed_at2020',    'out',    'OUT',     'out', 'audio_analog', 'xlr',      'mic',  1, 'requires',   NULL, 1),
  ('prt_headset_out',   'mdl_seed_headset',   'out',    'OUT',     'out', 'audio_analog', 'xlr',      'mic',  1, 'requires',   NULL, 1),
  ('prt_lav_out',       'mdl_seed_lav',       'out',    'OUT',     'out', 'audio_analog', 'trs_mini', 'mic',  1, 'none',       NULL, 1),

  -- MG10XU
  ('prt_mg_ch1',        'mdl_seed_mg10xu', 'ch1',      'CH1',      'in',  'audio_analog', 'xlr',   'mic',  1, 'provides', NULL, 1),
  ('prt_mg_ch2',        'mdl_seed_mg10xu', 'ch2',      'CH2',      'in',  'audio_analog', 'xlr',   'mic',  1, 'provides', NULL, 2),
  ('prt_mg_ch3',        'mdl_seed_mg10xu', 'ch3',      'CH3',      'in',  'audio_analog', 'xlr',   'mic',  1, 'provides', NULL, 3),
  ('prt_mg_ch4',        'mdl_seed_mg10xu', 'ch4',      'CH4',      'in',  'audio_analog', 'trs',   'line', 2, 'none',     NULL, 4),
  ('prt_mg_usb_in',     'mdl_seed_mg10xu', 'usb_in',   'USB IN',   'in',  'audio_digital','usb_b', NULL,   2, 'none',     NULL, 5),
  ('prt_mg_main',       'mdl_seed_mg10xu', 'main_out', 'MAIN OUT', 'out', 'audio_analog', 'trs',   'line', 2, 'none',     'bus_mg10xu_main', 6),
  ('prt_mg_aux1',       'mdl_seed_mg10xu', 'aux1_out', 'AUX1 OUT', 'out', 'audio_analog', 'trs',   'line', 1, 'none',     'bus_mg10xu_aux1', 7),
  ('prt_mg_usb_send',   'mdl_seed_mg10xu', 'usb_send', 'USB OUT',  'out', 'audio_digital','usb_b', NULL,   2, 'none',     'bus_mg10xu_usb',  8),

  -- AG03
  ('prt_ag_ch1',        'mdl_seed_ag03', 'ch1',      'CH1 (MIC)', 'in',  'audio_analog', 'xlr',   'mic',  1, 'provides', NULL, 1),
  ('prt_ag_ch2',        'mdl_seed_ag03', 'ch2',      'CH2 (LINE)','in',  'audio_analog', 'trs',   'line', 2, 'none',     NULL, 2),
  ('prt_ag_usb_in',     'mdl_seed_ag03', 'usb_in',   'USB IN',    'in',  'audio_digital','usb_c', NULL,   2, 'none',     NULL, 3),
  ('prt_ag_monitor',    'mdl_seed_ag03', 'mon_out',  'MONITOR OUT','out','audio_analog', 'trs',   'line', 2, 'none',     'bus_ag03_main',   4),
  ('prt_ag_usb_send',   'mdl_seed_ag03', 'usb_send', 'USB OUT',   'out', 'audio_digital','usb_c', NULL,   2, 'none',     'bus_ag03_usb',    5),
  ('prt_ag_phones',     'mdl_seed_ag03', 'phones',   'PHONES',    'out', 'audio_analog', 'trs',   'line', 2, 'none',     'bus_ag03_phones', 6),

  -- speaker / headphone / recorder / DI
  ('prt_spk_in',        'mdl_seed_speaker',   'in',   'INPUT',  'in', 'audio_analog', 'trs',  'line', 1, 'none', NULL, 1),
  ('prt_hp_in',         'mdl_seed_headphone', 'in',   'INPUT',  'in', 'audio_analog', 'trs',  'line', 2, 'none', NULL, 1),
  ('prt_rec_in',        'mdl_seed_recorder',  'in',   'LINE IN','in', 'audio_analog', 'trs_mini','line',2,'none', NULL, 1),
  ('prt_di_in',         'mdl_seed_di',        'in',   'INPUT',  'in', 'audio_analog', 'ts',   'instrument', 1, 'none', NULL, 1),
  ('prt_di_out',        'mdl_seed_di',        'out',  'OUTPUT', 'out','audio_analog', 'xlr',  'mic',  1, 'requires', NULL, 2),

  -- PC
  ('prt_pc_usb_in',     'mdl_seed_pc', 'usb_in',        'USB オーディオ入力', 'in',  'audio_digital','usb_c',    NULL,   2, 'none', NULL, 1),
  ('prt_pc_usb_out',    'mdl_seed_pc', 'usb_out',       'USB オーディオ出力', 'out', 'audio_digital','usb_c',    NULL,   2, 'none', NULL, 2),
  ('prt_pc_line_in',    'mdl_seed_pc', 'line_in',       'マイク入力',        'in',  'audio_analog', 'trs_mini', 'line', 2, 'none', NULL, 3),
  ('prt_pc_hp_out',     'mdl_seed_pc', 'headphone_out', 'ヘッドホン出力',     'out', 'audio_analog', 'trs_mini', 'line', 2, 'none', NULL, 4),
  ('prt_pc_cap_in',     'mdl_seed_pc', 'capture_in',    'USB 映像入力',      'in',  'video',        'usb_c',    NULL,   1, 'none', NULL, 5),
  ('prt_pc_hdmi_out',   'mdl_seed_pc', 'hdmi_out',      'HDMI 出力',         'out', 'video',        'hdmi',     NULL,   1, 'none', NULL, 6),

  -- OBS
  ('prt_obs_audio_in',  'mdl_seed_obs', 'audio_in',      '音声ソース',     'in',  'audio_digital', 'none', NULL, 2, 'none', NULL,               1),
  ('prt_obs_video_in',  'mdl_seed_obs', 'video_in',      '映像ソース',     'in',  'video',         'none', NULL, 1, 'none', NULL,               2),
  ('prt_obs_stream',    'mdl_seed_obs', 'stream_out',    '配信音声',       'out', 'audio_digital', 'none', NULL, 2, 'none', 'bus_obs_program',  3),
  ('prt_obs_prog_video','mdl_seed_obs', 'program_video', '配信映像',       'out', 'video',         'none', NULL, 1, 'none', 'bus_obs_program',  4),
  ('prt_obs_monitor',   'mdl_seed_obs', 'monitor_out',   'モニタリング出力','out', 'audio_digital', 'none', NULL, 2, 'none', 'bus_obs_monitor', 5),

  -- conferencing
  ('prt_meet_in',       'mdl_seed_meet',     'mic_in',  '送信する音声',       'in',  'audio_digital', 'none', NULL, 2, 'none', NULL, 1),
  ('prt_meet_out',      'mdl_seed_meet',     'spk_out', 'リモート参加者の音声','out', 'audio_digital', 'none', NULL, 2, 'none', NULL, 2),
  ('prt_zoom_in',       'mdl_seed_zoom_app', 'mic_in',  '送信する音声',       'in',  'audio_digital', 'none', NULL, 2, 'none', NULL, 1),
  ('prt_zoom_out',      'mdl_seed_zoom_app', 'spk_out', 'リモート参加者の音声','out', 'audio_digital', 'none', NULL, 2, 'none', NULL, 2),

  -- video chain
  ('prt_cam_hdmi',      'mdl_seed_camera',    'hdmi_out', 'HDMI OUT', 'out', 'video', 'hdmi',  NULL, 1, 'none', NULL, 1),
  ('prt_cl_in',         'mdl_seed_camlink',   'hdmi_in',  'HDMI IN',  'in',  'video', 'hdmi',  NULL, 1, 'none', NULL, 1),
  ('prt_cl_out',        'mdl_seed_camlink',   'usb_out',  'USB OUT',  'out', 'video', 'usb_c', NULL, 1, 'none', NULL, 2),
  ('prt_proj_in',       'mdl_seed_projector', 'hdmi_in',  'HDMI IN',  'in',  'video', 'hdmi',  NULL, 1, 'none', NULL, 1),

  -- ATEM Mini
  ('prt_atem_in1',      'mdl_seed_atem', 'hdmi1',     'HDMI 1',    'in',  'av',    'hdmi',  NULL, 1, 'none', NULL,              1),
  ('prt_atem_in2',      'mdl_seed_atem', 'hdmi2',     'HDMI 2',    'in',  'av',    'hdmi',  NULL, 1, 'none', NULL,              2),
  ('prt_atem_mic1',     'mdl_seed_atem', 'mic1',      'MIC 1',     'in',  'audio_analog', 'trs_mini', 'line', 2, 'none', NULL,  3),
  ('prt_atem_prog',     'mdl_seed_atem', 'hdmi_out',  'HDMI OUT',  'out', 'av',    'hdmi',  NULL, 1, 'none', 'bus_atem_program', 4),
  ('prt_atem_usb',      'mdl_seed_atem', 'usb_out',   'USB (Webcam)','out','av',   'usb_c', NULL, 1, 'none', 'bus_atem_usb',     5),

  -- house PA
  ('prt_pa_in',         'mdl_seed_house_pa', 'line_in',  '壁面 LINE IN',  'in',  'audio_analog', 'trs', 'line', 2, 'none', NULL, 1),
  ('prt_pa_out',        'mdl_seed_house_pa', 'spk_out',  '天井スピーカー', 'out', 'audio_analog', 'trs', 'line', 2, 'none', NULL, 2);

-- Sensible starting matrix. Copied into a setup when the node is added; the
-- setup document is authoritative from then on.
INSERT INTO device_model_default_routes (model_id, in_port_id, bus_id) VALUES
  ('mdl_seed_mg10xu', 'prt_mg_ch1',       'bus_mg10xu_main'),
  ('mdl_seed_mg10xu', 'prt_mg_ch1',       'bus_mg10xu_usb'),
  ('mdl_seed_mg10xu', 'prt_mg_ch2',       'bus_mg10xu_main'),
  ('mdl_seed_mg10xu', 'prt_mg_ch2',       'bus_mg10xu_usb'),
  ('mdl_seed_mg10xu', 'prt_mg_ch3',       'bus_mg10xu_main'),
  ('mdl_seed_mg10xu', 'prt_mg_ch3',       'bus_mg10xu_usb'),
  -- USB IN deliberately absent from the USB bus: that omission is Mix-Minus.
  ('mdl_seed_mg10xu', 'prt_mg_usb_in',    'bus_mg10xu_main'),
  ('mdl_seed_ag03',   'prt_ag_ch1',       'bus_ag03_main'),
  ('mdl_seed_ag03',   'prt_ag_ch1',       'bus_ag03_usb'),
  ('mdl_seed_ag03',   'prt_ag_ch1',       'bus_ag03_phones'),
  ('mdl_seed_ag03',   'prt_ag_usb_in',    'bus_ag03_main'),
  ('mdl_seed_ag03',   'prt_ag_usb_in',    'bus_ag03_phones'),
  ('mdl_seed_obs',    'prt_obs_audio_in', 'bus_obs_program'),
  ('mdl_seed_obs',    'prt_obs_video_in', 'bus_obs_program'),
  ('mdl_seed_atem',   'prt_atem_in1',     'bus_atem_program'),
  ('mdl_seed_atem',   'prt_atem_in1',     'bus_atem_usb'),
  ('mdl_seed_atem',   'prt_atem_in2',     'bus_atem_program'),
  ('mdl_seed_atem',   'prt_atem_in2',     'bus_atem_usb'),
  ('mdl_seed_atem',   'prt_atem_mic1',    'bus_atem_program'),
  ('mdl_seed_atem',   'prt_atem_mic1',    'bus_atem_usb');
