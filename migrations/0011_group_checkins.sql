-- Migration number: 0011
-- One Check-in per Member per Group per Game Night: a Member answers each
-- Group separately, and the answer and its Note show only on that Group's
-- Board. Additive only: the old checkins table stays untouched, so code
-- rolled back with wrangler rollback still reads it. Answers given after this
-- migration are invisible to rolled-back code until it is rolled forward; no
-- data is destroyed either way. A later migration drops checkins.

CREATE TABLE group_checkins (
  group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  game_night TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('yes', 'maybe', 'no')),
  -- At most 140 code points; NULL when the Member has no Note for this Group.
  note TEXT,
  -- Set once "someone said Yes" is sent for this Member, Group and night, so
  -- switching away from Yes and back sends nothing more.
  said_yes_notified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_id, game_night)
);

-- The Reminder looks up a Member's Check-ins for one night.
CREATE INDEX group_checkins_member_night ON group_checkins (member_id, game_night);

-- Copies each Check-in of a night the Reset has not frozen yet into every
-- Group its Member is in now, keeping the answer, Note, said_yes_notified and
-- updated_at, so tonight's answers survive the deploy and no stale "someone
-- said Yes" push fires. Frozen nights already live in History.
INSERT INTO group_checkins (group_id, member_id, game_night, availability, note, said_yes_notified, updated_at)
SELECT m.group_id, c.member_id, c.game_night, c.availability, c.note, c.said_yes_notified, c.updated_at
FROM checkins c
JOIN memberships m ON m.member_id = c.member_id
WHERE c.game_night >= COALESCE((SELECT last_reset_game_night FROM scheduler_state WHERE id = 1), '');
