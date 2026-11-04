-- Migration number: 0008
-- The Game Night of the most recent Reminder and of the most recent Daily
-- Summary, so the hourly scheduled run sends each at most once per Game
-- Night. A job claims its night here before it sends anything, so a run that
-- dies after the claim loses that night's pushes; they are never replayed.
-- NULL means the job has never run. Additive only, so code rolled back with
-- wrangler rollback ignores the columns.
ALTER TABLE scheduler_state ADD COLUMN last_reminder_game_night TEXT;
ALTER TABLE scheduler_state ADD COLUMN last_summary_game_night TEXT;
