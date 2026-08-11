-- echo_cancels indicates whether the device has a built-in acoustic echo canceller.
--
-- This unit subtracts what it played out of what it picked up. It is a spec-sheet fact
-- about the model, not a claim about any particular room.

ALTER TABLE device_models ADD COLUMN echo_cancels INTEGER NOT NULL DEFAULT 0;
