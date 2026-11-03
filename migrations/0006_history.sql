-- Migration number: 0006
-- History: each Group's past Game Nights, frozen by the Reset that ends them.
-- game_night is the Game Night's name (YYYY-MM-DD, from app/game-night.ts).
-- Names are not stored: History joins members at read time, so renames reach
-- the past. The Yes count is derived from history_rows, never stored.
-- Deleting a Group or a login erases its History by ON DELETE CASCADE.

-- One past night of one Group: the threshold in force and the final state at
-- the Reset. 'on' is Game On, 'off' is Game Off, 'never' is Never on.
CREATE TABLE history_nights (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  game_night TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  final_state TEXT NOT NULL CHECK (final_state IN ('on', 'off', 'never')),
  UNIQUE (group_id, game_night)
);

-- One row per Member who was in the Group at the night's end, with their
-- Availability and Note, or NULL availability for no answer.
CREATE TABLE history_rows (
  night_id INTEGER NOT NULL REFERENCES history_nights (id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  availability TEXT CHECK (availability IS NULL OR availability IN ('yes', 'maybe', 'no')),
  note TEXT,
  PRIMARY KEY (night_id, member_id)
);

CREATE INDEX history_rows_member_id ON history_rows (member_id);
