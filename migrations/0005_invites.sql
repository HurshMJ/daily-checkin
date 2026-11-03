-- Migration number: 0005
-- Invites: single-use links an Owner makes so a friend can join their Group.
-- Times are ISO-8601 UTC text (Date.toISOString()) from the app's clock.
-- Tokens are never stored: an Invite keeps only the SHA-256 of its token, as
-- 64 lower-case hex digits, and the link is shown to the Owner once. An Invite
-- is usable while used_at and cancelled_at are both NULL; it never expires.

CREATE TABLE invites (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  -- The Member who made it; NULL once that login is deleted.
  created_by INTEGER REFERENCES members (id) ON DELETE SET NULL,
  -- Who it is for, seen only by the Owner: trimmed and NFC-normalised, 1 to
  -- 40 code points, no invisible characters; NULL when left blank.
  label TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX invites_group_id ON invites (group_id);
