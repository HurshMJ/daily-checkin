-- Migration number: 0007
-- Push notifications: which event pushes were already sent, each device's
-- browser push subscription, and each Member's notification toggles.
-- Additive only, so code rolled back with wrangler rollback ignores it.

-- Set once "someone said Yes" is sent for this Check-in's Member and night,
-- so switching away from Yes and back sends nothing more.
ALTER TABLE checkins ADD COLUMN said_yes_notified INTEGER NOT NULL DEFAULT 0;

-- Set once Game On, and once Game Off, is sent for the Group and night.
ALTER TABLE group_night_state ADD COLUMN game_on_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_night_state ADD COLUMN game_off_sent INTEGER NOT NULL DEFAULT 0;

-- Rows written before this migration count as already sent, so no stale push
-- fires for a night in progress at deploy time. A Group already on at deploy
-- therefore cannot send Game Off that one night.
UPDATE group_night_state SET game_on_sent = was_on, game_off_sent = was_on;
UPDATE checkins SET said_yes_notified = 1 WHERE availability = 'yes';

-- One browser push subscription per device. It belongs to the session that
-- turned push on, so logging that device out deletes it by ON DELETE CASCADE.
-- Saving an endpoint that already exists moves it to the current Member and
-- session. Endpoints and keys are never logged.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL REFERENCES sessions (token_hash) ON DELETE CASCADE,
  -- The subscription's keys, base64url as the browser gives them.
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX push_subscriptions_member_id ON push_subscriptions (member_id);
CREATE INDEX push_subscriptions_session_token_hash ON push_subscriptions (session_token_hash);

-- A Member's choice for one notification type. A missing row means on.
-- reminder and daily_summary are listed now for a later ticket, because
-- SQLite cannot change a CHECK without rebuilding the table.
CREATE TABLE notification_prefs (
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('said_yes', 'game_on', 'game_off', 'reminder', 'daily_summary')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (member_id, type)
);
