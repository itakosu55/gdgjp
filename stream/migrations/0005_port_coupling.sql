-- Space coupling moves from the device category onto the jack.
--
-- What couples to a room is not the device but the transducer, and a transducer
-- is a port. The category could stand in for it only while every coupling
-- device was one *whole* transducer — a mic, a speaker. It is not: a USB
-- speakerphone is one unit with both faces, an onboard-mic camera hears as well
-- as sees, and a laptop is a mic and a speaker plus six jacks that are neither.
-- See docs/260805_stream_av_designer.md §11.2.
--
-- The direction cannot be derived from `direction`: a mic's OUT and a speaker's
-- IN are both "the jack facing the room" and point opposite ways. Nor from the
-- category any more, which is the whole point. So it is stated per port.
--
-- Migration 0003 and 0004 are left alone — their INSERTs name their columns, so
-- they keep working — and the seeded values are set here instead, which is the
-- flow 0004 established: a new migration adds data, older ones are never
-- rewritten.

ALTER TABLE device_model_ports ADD COLUMN couples TEXT
  CHECK (couples IS NULL OR couples IN ('from_space', 'to_space'));

-- The backfill reproduces `CATEGORY_SPACE_COUPLING` exactly as the graph read
-- it until now: mics and cameras hand the space's signal to their outputs,
-- speakers and displays emit what arrives at their inputs, and a conferencing
-- app does both — its inputs are what it sends into the meeting, its outputs
-- what the meeting sends back. Detection results are therefore unchanged by
-- this migration, which is what the existing tests assert.
UPDATE device_model_ports SET couples = 'from_space'
  WHERE direction = 'out'
    AND model_id IN (
      SELECT id FROM device_models
      WHERE category IN ('mic', 'camera', 'software_conferencing')
    );

UPDATE device_model_ports SET couples = 'to_space'
  WHERE direction = 'in'
    AND model_id IN (
      SELECT id FROM device_models
      WHERE category IN ('speaker', 'display', 'software_conferencing')
    );
