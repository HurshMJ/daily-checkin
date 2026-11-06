-- Migration number: 0012
-- The right to create Groups. Only a Member the Operator has allowed, with
-- `npm run operator:allow-groups`, can create a Group; every new login, from
-- a Setup Link or an Invite, starts without the right. Owning a Group by
-- hand-over does not give it.
-- Every Member who owns a Group when this runs keeps the right, so current
-- Owners notice no change; everyone else starts without it.
-- Additive only, so code rolled back with wrangler rollback ignores it and
-- every Member can create Groups again.

ALTER TABLE members ADD COLUMN can_create_groups INTEGER NOT NULL DEFAULT 0 CHECK (can_create_groups IN (0, 1));

UPDATE members SET can_create_groups = 1 WHERE id IN (SELECT owner_id FROM groups);
