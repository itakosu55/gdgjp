-- A laptop's own mic and speaker become ports of the laptop.
--
-- They were separate `mic` / `speaker` models (0004) because a `computer`
-- coupled to no space, so that was the only way a presenter's own machine could
-- touch the room at all. The price was four rows of data entry per laptop, two
-- of them cables that do not physically exist — the built-in mic is not plugged
-- into the 3.5mm jack — and until all four were written the graph had no path,
-- so §9.1's accident (the presenter's laptop picking the room up and sending it
-- back into the meeting) was undetectable. Coupling now lives on the port
-- (0005), so the honest form is available: see §11.1 and §11.9-5.
--
-- No connector and no level, for the same reason 0004 gave: there is no jack to
-- mismatch. `internal_routing` on `mdl_seed_pc` stays `none` — a machine does
-- not route its own mic into its own speaker, and saying it did would invent an
-- echo loop on every laptop in the catalog.

INSERT INTO device_model_ports
  (id, model_id, key, label, direction, signal, connector, level, channels, phantom, bus_id, couples, sort_order)
VALUES
  ('prt_pc_builtin_mic', 'mdl_seed_pc', 'builtin_mic', '内蔵マイク',     'in',  'audio_analog', 'none', NULL, 1, 'none', NULL, 'from_space', 7),
  ('prt_pc_builtin_spk', 'mdl_seed_pc', 'builtin_spk', '内蔵スピーカー', 'out', 'audio_analog', 'none', NULL, 2, 'none', NULL, 'to_space',   8);

-- The ledger rows go first: `devices.model_id` has no ON DELETE clause, so
-- dropping the models alone would leave rows the linter reports as
-- `unknown-reference` — a broken 台帳 in place of the thing being removed.
-- §11.7's test is whether a unit can be carried out of the building on its own,
-- and a built-in mic cannot, so it must not be a row a future double-booking
-- rule can reserve.
DELETE FROM devices
  WHERE model_id IN ('mdl_seed_builtin_mic', 'mdl_seed_builtin_spk');

DELETE FROM device_models
  WHERE id IN ('mdl_seed_builtin_mic', 'mdl_seed_builtin_spk');
