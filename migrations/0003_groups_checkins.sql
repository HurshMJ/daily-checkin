-- Migration number: 0003
-- Groups, their Members, tonight's Check-ins, and whether each Group was Game
-- On on a Game Night. Times are ISO-8601 UTC text (Date.toISOString()) from
-- the app's clock. game_night is the Game Night's name: the UTC+4 date
-- (YYYY-MM-DD) of the 06:00 UTC+4 it starts at, from app/game-night.ts.
-- Names and Notes are trimmed and NFC-normalised before they are stored.

CREATE TABLE groups (
  id INTEGER PRIMARY KEY,
  -- 1 to 40 code points; names are not unique.
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES members (id),
  -- The Game On Threshold: Yes answers needed for Game On.
  threshold INTEGER NOT NULL DEFAULT 3 CHECK (threshold >= 1),
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id)
);

CREATE INDEX memberships_member_id ON memberships (member_id);

-- One Check-in per Member per Game Night. It shows on every Board the Member
-- is on. Past nights stay for History; there is no row for "no answer yet".
CREATE TABLE checkins (
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  game_night TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('yes', 'maybe', 'no')),
  -- At most 140 code points; NULL when the Member has no Note.
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, game_night)
);

-- Set once a Group reaches Game On during a Game Night and never cleared
-- within it, so the Board can tell Game Off from "Needs N more Yes".
CREATE TABLE group_night_state (
  group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  game_night TEXT NOT NULL,
  was_on INTEGER NOT NULL DEFAULT 0 CHECK (was_on IN (0, 1)),
  PRIMARY KEY (group_id, game_night)
);
