-- RP auth tables consumed by `initializeRpAuth` in @gdgjp/gdg-lib.
-- The IdP (accounts.gdgs.jp) is the source of truth; these rows only mirror
-- identity so app tables can hold a stable local user id.

CREATE TABLE "user" (
  id           TEXT NOT NULL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  image        TEXT,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  oidc_issuer  TEXT,
  oidc_subject TEXT,
  created_at   INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX user_oidc_identity_idx ON "user" (oidc_issuer, oidc_subject);

CREATE TABLE oidc_session (
  id                      TEXT NOT NULL PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  issuer                  TEXT NOT NULL,
  subject                 TEXT NOT NULL,
  access_token            TEXT NOT NULL,
  refresh_token           TEXT,
  id_token                TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  expires_at              INTEGER NOT NULL,
  created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX oidc_session_user_idx ON oidc_session (user_id);
