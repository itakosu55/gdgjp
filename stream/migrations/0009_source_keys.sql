-- The screen share's picture and its sound are one source (§12.4).
--
-- 0004 split them into separate ports on purpose: "the video's sound is in the
-- room but not on the stream" is exactly that asymmetry, and one combined port
-- hides it. What was missing was never fewer ports but the *name of the
-- pairing* — without it the model cannot say that `share_audio_out` and
-- `share_video_out` are the same share, so no rule can report a half-shared
-- screen.
--
-- `source_key` is that name, and it is the same concept whether the ports are
-- expandable or fixed. 0007 gave it to OBS's browser pair; this gives it to the
-- conferencing apps' eight ports, which have had the relationship all along and
-- no way to state it.
--
-- Grouping is per direction: what we send to the meeting and what the meeting
-- sends back are two shares, not one. `cam` therefore names a feature rather
-- than a pair anything can compare — your camera and your microphone are chosen
-- separately, so there is no audio half in that direction and there is not
-- meant to be.

UPDATE device_model_ports
  SET source_key = 'cam'
  WHERE key IN ('cam_video_in', 'cam_video_out')
    AND model_id IN (SELECT id FROM device_models WHERE category = 'software_conferencing');

UPDATE device_model_ports
  SET source_key = 'share'
  WHERE key IN ('share_audio_in', 'share_video_in', 'share_audio_out', 'share_video_out')
    AND model_id IN (SELECT id FROM device_models WHERE category = 'software_conferencing');
