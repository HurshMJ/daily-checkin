-- Migration number: 0009
-- Display Names and the one namespace usernames and Display Names share.
--
-- members.display_name is the optional Display Name: trimmed and
-- NFC-normalised, otherwise as typed. NULL means the Member shows their
-- username.
--
-- name_keys is the single owner of the case-insensitive namespace: every
-- name a Member holds, lower-cased, is one row. A Member holds one or two
-- keys: the username key and, when set and different, the Display Name key.
-- The primary key refuses a name another Member already holds, so every write
-- that changes a Member's names runs as one D1 batch that deletes the
-- Member's keys, inserts the new ones and updates members; a clash rolls the
-- whole batch back. members.username_lower stays as the login lookup key.

ALTER TABLE members ADD COLUMN display_name TEXT;

CREATE TABLE name_keys (
  name_key TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE
);

CREATE INDEX name_keys_member_id ON name_keys (member_id);

-- Every existing Member holds their username key.
INSERT INTO name_keys (name_key, member_id) SELECT username_lower, id FROM members;
