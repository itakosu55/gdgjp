-- Layer 1: 型番カタログ (device models) and layer 2: 機材台帳 (device instances).
--
-- The catalog is a shared pool: any signed-in user may add a model or a device,
-- and every user can reference them. Ownership is a free-text note only — it is
-- deliberately NOT an access-control boundary, because gear is shared across
-- chapters.

CREATE TABLE device_models (
  id       TEXT NOT NULL PRIMARY KEY,
  maker    TEXT,
  name     TEXT NOT NULL,
  -- mic | headphone | speaker | mixer | audio_interface | di | wireless_rx
  -- | recorder | camera | switcher | capture | display | computer
  -- | software_broadcast | software_conferencing | blackbox | generic
  category TEXT NOT NULL,
  -- How signal moves between this device's own ports:
  --   matrix      — routing is the (input × bus) matrix stored on the setup
  --   passthrough — every input reaches every same-medium output (DI, blackbox)
  --   none        — inputs and outputs are unrelated (endpoints, conferencing apps)
  internal_routing TEXT NOT NULL DEFAULT 'none'
    CHECK (internal_routing IN ('matrix', 'passthrough', 'none')),
  notes      TEXT,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);

CREATE INDEX device_models_category_idx ON device_models (category);

CREATE TABLE device_model_buses (
  id       TEXT NOT NULL PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  label    TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('main', 'aux', 'usb', 'monitor', 'sub')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (model_id, key)
);

CREATE TABLE device_model_ports (
  id        TEXT NOT NULL PRIMARY KEY,
  model_id  TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  label     TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  -- av = HDMI/SDI carrying both audio and video.
  signal    TEXT NOT NULL
    CHECK (signal IN ('audio_analog', 'audio_digital', 'video', 'av')),
  connector TEXT NOT NULL DEFAULT 'none'
    CHECK (connector IN ('xlr', 'trs', 'ts', 'trs_mini', 'rca', 'hdmi', 'sdi',
                         'usb_b', 'usb_c', 'speakon', 'none')),
  level     TEXT CHECK (level IS NULL OR level IN ('mic', 'line', 'instrument', 'speaker')),
  channels  INTEGER NOT NULL DEFAULT 1 CHECK (channels >= 1),
  -- provides: can supply +48V. requires: needs it. damaged_by: ribbon mics etc.
  phantom   TEXT NOT NULL DEFAULT 'none'
    CHECK (phantom IN ('provides', 'requires', 'damaged_by', 'none')),
  -- Output ports belong to a bus; input ports do not.
  bus_id    TEXT REFERENCES device_model_buses(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (model_id, key)
);

CREATE INDEX device_model_ports_model_idx ON device_model_ports (model_id);

-- Template for the setup-level routing matrix. Copied into a setup when a node
-- is added; the setup document is authoritative from then on.
CREATE TABLE device_model_default_routes (
  model_id   TEXT NOT NULL REFERENCES device_models(id) ON DELETE CASCADE,
  in_port_id TEXT NOT NULL REFERENCES device_model_ports(id) ON DELETE CASCADE,
  bus_id     TEXT NOT NULL REFERENCES device_model_buses(id) ON DELETE CASCADE,
  PRIMARY KEY (model_id, in_port_id, bus_id)
);

CREATE TABLE devices (
  id         TEXT NOT NULL PRIMARY KEY,
  model_id   TEXT NOT NULL REFERENCES device_models(id),
  name       TEXT NOT NULL,
  -- Something that identifies the physical unit on site: sticker colour, asset tag.
  identifier TEXT,
  -- Free-text memo ("東京チャプター備品" / "田中さん私物"). Not an ACL.
  owner_note TEXT,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);

CREATE INDEX devices_model_idx ON devices (model_id);
