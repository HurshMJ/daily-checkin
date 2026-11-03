-- Migration number: 0004
-- Failed logins, one row per failure, for the login limits in
-- app/auth/login-limits.ts: a username is locked after 5 failures in 15
-- minutes, and an IP is refused after 20 failures in an hour. A failure adds a
-- 'username' row and an 'ip' row; an attempt on a locked username adds only
-- the 'ip' row. Times are ISO-8601 UTC text (Date.toISOString()) from the
-- app's clock, so they compare correctly as strings. Rows older than an hour
-- count toward nothing and are deleted whenever a failure is recorded.

CREATE TABLE login_failures (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('username', 'ip')),
  -- usernameKey() of the typed username, known or not; or the CF-Connecting-IP
  -- header, or 'unknown' when the request has none.
  key TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

CREATE INDEX login_failures_kind_key_failed_at ON login_failures (kind, key, failed_at);
