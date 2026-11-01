-- Migration number: 0001
-- Holds the Game Night of the most recent Reset, so the hourly scheduled run
-- can tell when a Reset is due and catch up after a missed run.
-- The table has at most one row; the CHECK on id enforces that.
CREATE TABLE scheduler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_reset_game_night TEXT
);
