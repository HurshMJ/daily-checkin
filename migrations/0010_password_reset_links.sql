-- Migration number: 0010
-- Password Reset Links: single-use links that let a Member who forgot their
-- password set a new one. An Owner of a Group the Member is in makes one on
-- the Group page, or the Operator prints one with `npm run operator:reset-link`.
-- Times are ISO-8601 UTC text (Date.toISOString()) from the app's clock.
-- Tokens are never stored: a link keeps only the SHA-256 of its token, as 64
-- lower-case hex digits, and the link is shown once. A link is usable while
-- used_at and cancelled_at are NULL and expires_at is in the future; making a
-- new link for a Member cancels every older usable one.
-- Additive only, so code rolled back with wrangler rollback ignores it.

CREATE TABLE password_reset_links (
  token_hash TEXT PRIMARY KEY,
  -- The Member whose password the link sets.
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  -- The Owner who made it, or NULL when the Operator made it. A maker who
  -- deletes their login takes their links with them, so no link outlives the
  -- person who can cancel it.
  made_by INTEGER REFERENCES members (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX password_reset_links_member_id ON password_reset_links (member_id);
CREATE INDEX password_reset_links_made_by ON password_reset_links (made_by);

-- Set when a Password Reset Link sets the Member's password, and cleared by
-- their next successful login, which shows the "your password was reset"
-- notice once.
ALTER TABLE members ADD COLUMN password_reset_notice INTEGER NOT NULL DEFAULT 0 CHECK (password_reset_notice IN (0, 1));
