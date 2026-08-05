-- Layer 3: イベント (a broadcast occasion) and 構成 (a wiring setup).
--
-- `event_devices` is the gear actually brought to the event. A setup may only
-- reference devices listed here; the `device-not-in-event` lint rule enforces it.

CREATE TABLE events (
  id           TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL,
  starts_at    INTEGER,
  venue        TEXT,
  -- Optional link out to connpass / Meetup / the wiki runbook.
  external_url TEXT,
  created_by   TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at   INTEGER
);

CREATE INDEX events_starts_at_idx ON events (starts_at);

CREATE TABLE event_devices (
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  note      TEXT,
  PRIMARY KEY (event_id, device_id)
);

CREATE INDEX event_devices_device_idx ON event_devices (device_id);

-- A setup is one *alternative* wiring for the event ("本番" / "リハ" / "プランB"),
-- i.e. alternatives that are mutually exclusive in time. Simultaneous parallel
-- tracks are a separate axis and are not modelled yet — see
-- docs/260805_stream_av_designer.md §8 before adding one.
CREATE TABLE setups (
  id         TEXT NOT NULL PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- SetupDoc JSON. Validated by the zod schema in app/lib/av/schema.ts.
  doc        TEXT NOT NULL,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);

CREATE INDEX setups_event_idx ON setups (event_id);

CREATE TABLE setup_revisions (
  id         TEXT NOT NULL PRIMARY KEY,
  setup_id   TEXT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  doc        TEXT NOT NULL,
  author_id  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX setup_revisions_setup_idx ON setup_revisions (setup_id, created_at);
