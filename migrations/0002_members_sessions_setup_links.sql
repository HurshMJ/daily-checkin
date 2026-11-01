-- Migration number: 0002
-- Logins, their sessions, and the Operator's Setup Links.
-- Times are ISO-8601 UTC text (Date.toISOString()) from the app's clock, so
-- they compare correctly as strings. Tokens are never stored: sessions and
-- setup_links keep only the SHA-256 of the token, as 64 lower-case hex digits.

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  -- Trimmed and NFC-normalised, otherwise as typed.
  username TEXT NOT NULL,
  -- toLowerCase() of username; uniqueness ignores case.
  username_lower TEXT NOT NULL UNIQUE,
  colour TEXT NOT NULL CHECK (
    colour IN ('blue', 'sky', 'cyan', 'indigo', 'violet', 'purple', 'pink', 'slate')
  ),
  -- PBKDF2-SHA256 output and its random salt, both hex; the iteration count is
  -- kept per hash so the current count can change without a rehash.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX sessions_member_id ON sessions (member_id);

CREATE TABLE setup_links (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX setup_links_label ON setup_links (label);
