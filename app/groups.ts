import type { AvatarColour } from "~/auth/palette";
import { type MemberNames, shownName } from "~/auth/rules";
import { groupGameClaims, groupGameOnStatement } from "~/checkins";
import { gameNightOf } from "~/game-night";
import { batchWithClaims, createNotifications, type Delivery } from "~/notifications";
import type { Clock } from "~/services";
import { codePoints, hasInvisible, INVISIBLE_MESSAGE, normaliseText } from "~/text-rules";

/** The longest Group name, in code points of the NFC form. */
export const MAX_GROUP_NAME_LENGTH = 40;

/** The Game On Threshold every new Group starts with. */
export const DEFAULT_THRESHOLD = 3;

/** The Group name as it is stored and shown: trimmed and NFC-normalised. */
export function normaliseGroupName(raw: string): string {
  return normaliseText(raw);
}

/**
 * Returns an error message for a normalised Group name, or null when it is
 * fine. Names are 1 to 40 code points, emoji allowed, and need not be unique.
 */
export function groupNameError(name: string): string | null {
  const length = codePoints(name);
  if (length < 1 || length > MAX_GROUP_NAME_LENGTH) return `Use 1 to ${MAX_GROUP_NAME_LENGTH} characters.`;
  if (hasInvisible(name)) return INVISIBLE_MESSAGE;
  return null;
}

/** The Game On Threshold's range: whole numbers of Yes answers. */
export const MIN_THRESHOLD = 1;
export const MAX_THRESHOLD = 99;

const THRESHOLD_MESSAGE = `Use a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`;

/**
 * Returns an error message for a submitted threshold, or null when it is a
 * whole number from 1 to 99 written plainly: digits only, no sign, no leading
 * zero, no spaces.
 */
export function thresholdError(raw: string): string | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return THRESHOLD_MESSAGE;
  const value = Number(raw);
  return value >= MIN_THRESHOLD && value <= MAX_THRESHOLD ? null : THRESHOLD_MESSAGE;
}

/**
 * A Group id from a URL: digits without a leading zero, as a safe integer,
 * or null for anything else.
 */
export function parseGroupId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** A Group as its Members see it on the Group page. */
export interface GroupView {
  id: number;
  name: string;
  threshold: number;
  ownerId: number;
  /** Every Member, in the order they joined, with their Shown name. */
  members: { id: number; shownName: string; username: string; colour: AvatarColour }[];
}

/** One of the Member's Groups as the profile lists it, for leaving. */
export interface MembershipView {
  groupId: number;
  name: string;
  isOwner: boolean;
  memberCount: number;
}

export type CreateGroupResult = { ok: true; groupId: number } | { ok: false; error: string; name: string };

/**
 * The result of an Owner's change to a Group. A Member who is not the Owner
 * gets not-owner, anyone outside the Group not-member; invalid carries the
 * message to show.
 */
export type GroupChangeResult =
  | { ok: true }
  | { ok: false; reason: "not-owner" | "not-member" }
  | { ok: false; reason: "invalid"; error: string };

/** Leaving: `deleted` says the Owner was the last Member, so the Group went with them. */
export type LeaveResult = { ok: true; deleted: boolean } | { ok: false; reason: "not-member" | "owner-must-hand-over" };

export const NOT_IN_GROUP_MESSAGE = "That person is not in this Group.";
export const OWNER_STAYS_MESSAGE = "The Owner cannot be removed. Make another Member Owner first.";
export const HAND_OVER_TO_OTHER_MESSAGE = "Choose another Member of the Group.";

/**
 * Groups and their Members, on D1 and the injected clock. With the push sender
 * and execution context, changes also send the Game On and Game Off pushes
 * they cause.
 */
export function createGroups({ env, clock, ...delivery }: { env: Env; clock: Clock } & Partial<Delivery>) {
  const db = env.DB;
  const notifications = createNotifications({ env, clock, ...delivery });
  const night = () => gameNightOf(clock.now());

  /**
   * Runs an Owner's or Member's change to one Group in one D1 batch with the
   * Game On statement and the Game On and Game Off claims, then sends what was
   * claimed to everyone but the actor. Returns the change's own results.
   */
  async function changeGroup(actorId: number, groupId: number, statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const tonight = night();
    const { results, events } = await batchWithClaims(
      db,
      [...statements, groupGameOnStatement(db, groupId, tonight)],
      groupGameClaims(db, groupId, tonight),
    );
    notifications.send(actorId, tonight, events);
    return results;
  }

  /** Where the Member stands in the Group: read only to explain a write that changed nothing. */
  async function standing(memberId: number, groupId: number): Promise<"owner" | "member" | "outsider"> {
    const row = await db
      .prepare(
        `SELECT g.owner_id FROM groups g JOIN memberships m ON m.group_id = g.id AND m.member_id = ?2
         WHERE g.id = ?1`,
      )
      .bind(groupId, memberId)
      .first<{ owner_id: number }>();
    if (!row) return "outsider";
    return row.owner_id === memberId ? "owner" : "member";
  }

  /** Why an Owner-only write changed nothing; `asOwner` explains it when the caller is the Owner. */
  async function refusal(memberId: number, groupId: number, asOwner: string): Promise<GroupChangeResult> {
    const stands = await standing(memberId, groupId);
    if (stands === "outsider") return { ok: false, reason: "not-member" };
    if (stands === "member") return { ok: false, reason: "not-owner" };
    return { ok: false, reason: "invalid", error: asOwner };
  }

  return {
    /**
     * Creates a Group owned by the Member, with the default threshold, and
     * makes the Member its first Member. Both rows are written in one D1
     * batch, which is one transaction, so a Group never lacks its Owner.
     */
    async createGroup(memberId: number, rawName: string): Promise<CreateGroupResult> {
      const name = normaliseGroupName(rawName);
      const error = groupNameError(name);
      if (error) return { ok: false, error, name };

      const now = clock.now().toISOString();
      const [inserted] = await db.batch<{ id: number }>([
        db
          .prepare("INSERT INTO groups (name, owner_id, threshold, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id")
          .bind(name, memberId, DEFAULT_THRESHOLD, now),
        db
          .prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (last_insert_rowid(), ?1, ?2)")
          .bind(memberId, now),
      ]);
      return { ok: true, groupId: inserted.results[0].id };
    },

    /** The Group with its Members, for one of its Members; null for anyone else or no such Group. */
    async groupFor(memberId: number, groupId: number): Promise<GroupView | null> {
      const [group, members] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            `SELECT g.id, g.name, g.threshold, g.owner_id FROM groups g
             JOIN memberships mine ON mine.group_id = g.id AND mine.member_id = ?2
             WHERE g.id = ?1`,
          )
          .bind(groupId, memberId),
        db
          .prepare(
            `SELECT p.id, p.username, p.display_name AS displayName, p.colour
             FROM memberships m JOIN members p ON p.id = m.member_id
             WHERE m.group_id = ?1 AND EXISTS (SELECT 1 FROM memberships mine WHERE mine.group_id = ?1 AND mine.member_id = ?2)
             ORDER BY m.joined_at, p.id`,
          )
          .bind(groupId, memberId),
      ]);
      const row = group.results[0] as { id: number; name: string; threshold: number; owner_id: number } | undefined;
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        threshold: row.threshold,
        ownerId: row.owner_id,
        members: (members.results as unknown as (MemberNames & { id: number; colour: AvatarColour })[]).map(
          (member) => ({ id: member.id, shownName: shownName(member), username: member.username, colour: member.colour }),
        ),
      };
    },

    /** Every Group the Member is in, in the order they joined, with its Member count. */
    async membershipsFor(memberId: number): Promise<MembershipView[]> {
      const { results } = await db
        .prepare(
          `SELECT g.id, g.name, g.owner_id = ?1 AS is_owner,
                  (SELECT COUNT(*) FROM memberships m WHERE m.group_id = g.id) AS member_count
           FROM memberships mine JOIN groups g ON g.id = mine.group_id
           WHERE mine.member_id = ?1
           ORDER BY mine.joined_at, g.id`,
        )
        .bind(memberId)
        .all<{ id: number; name: string; is_owner: number; member_count: number }>();
      return results.map((row) => ({
        groupId: row.id,
        name: row.name,
        isOwner: row.is_owner === 1,
        memberCount: row.member_count,
      }));
    },

    /** Renames the Group, only for its current Owner, with the same rule as a new Group's name. */
    async rename(ownerId: number, groupId: number, rawName: string): Promise<GroupChangeResult> {
      const name = normaliseGroupName(rawName);
      const error = groupNameError(name);
      if (error) return { ok: false, reason: "invalid", error };
      const result = await db
        .prepare("UPDATE groups SET name = ?1 WHERE id = ?2 AND owner_id = ?3")
        .bind(name, groupId, ownerId)
        .run();
      return result.meta.changes === 1 ? { ok: true } : refusal(ownerId, groupId, NOT_IN_GROUP_MESSAGE);
    },

    /**
     * Sets the Game On Threshold, only for the current Owner. In the same
     * batch the Group is marked Game On for tonight if its Yes count now
     * reaches the new threshold; a raised threshold never clears the mark,
     * so the Board reads Game Off. Either crossing sends its push.
     */
    async setThreshold(ownerId: number, groupId: number, raw: string): Promise<GroupChangeResult> {
      const error = thresholdError(raw);
      if (error) return { ok: false, reason: "invalid", error };
      const [updated] = await changeGroup(ownerId, groupId, [
        db.prepare("UPDATE groups SET threshold = ?1 WHERE id = ?2 AND owner_id = ?3").bind(Number(raw), groupId, ownerId),
      ]);
      return updated.meta.changes === 1 ? { ok: true } : refusal(ownerId, groupId, NOT_IN_GROUP_MESSAGE);
    },

    /**
     * Makes another current Member the Owner (Make Owner). The owner check
     * and the target's membership are part of the one UPDATE, so a racing
     * change cannot slip a handover through. Pending Invites are untouched.
     */
    async handOver(ownerId: number, groupId: number, toMemberId: number): Promise<GroupChangeResult> {
      const result = await db
        .prepare(
          `UPDATE groups SET owner_id = ?3 WHERE id = ?1 AND owner_id = ?2 AND ?3 <> ?2
           AND EXISTS (SELECT 1 FROM memberships WHERE group_id = ?1 AND member_id = ?3)`,
        )
        .bind(groupId, ownerId, toMemberId)
        .run();
      return result.meta.changes === 1 ? { ok: true } : refusal(ownerId, groupId, HAND_OVER_TO_OTHER_MESSAGE);
    },

    /**
     * Removes a Member other than the Owner, only for the current Owner. The
     * Member's Check-ins stay; they stop counting for this Group at once,
     * so a removal that drops the Group below its threshold sends Game Off.
     */
    async remove(ownerId: number, groupId: number, memberId: number): Promise<GroupChangeResult> {
      const [removed] = await changeGroup(ownerId, groupId, [
        db
          .prepare(
            `DELETE FROM memberships WHERE group_id = ?1 AND member_id = ?2 AND member_id <> ?3
             AND EXISTS (SELECT 1 FROM groups WHERE id = ?1 AND owner_id = ?3)`,
          )
          .bind(groupId, memberId, ownerId),
      ]);
      if (removed.meta.changes === 1) return { ok: true };
      return refusal(ownerId, groupId, memberId === ownerId ? OWNER_STAYS_MESSAGE : NOT_IN_GROUP_MESSAGE);
    },

    /**
     * The Member leaves the Group. The Owner cannot leave while other Members
     * remain; an Owner who is the last Member deletes the Group by leaving.
     * Both cases are one batch, each write guarding itself. The Group delete
     * is read through RETURNING, since D1 counts cascaded rows in changes.
     * Leaving sends no "left" push, but a leave that drops the Group below its
     * threshold sends Game Off to those still at Yes.
     */
    async leave(memberId: number, groupId: number): Promise<LeaveResult> {
      const [left, deleted] = await changeGroup(memberId, groupId, [
        db
          .prepare(
            `DELETE FROM memberships WHERE group_id = ?1 AND member_id = ?2
             AND EXISTS (SELECT 1 FROM groups WHERE id = ?1 AND owner_id <> ?2)`,
          )
          .bind(groupId, memberId),
        db
          .prepare(
            `DELETE FROM groups WHERE id = ?1 AND owner_id = ?2
             AND NOT EXISTS (SELECT 1 FROM memberships WHERE group_id = ?1 AND member_id <> ?2)
             RETURNING id`,
          )
          .bind(groupId, memberId),
      ]);
      if (left.meta.changes === 1) return { ok: true, deleted: false };
      if (deleted.results.length === 1) return { ok: true, deleted: true };
      const stands = await standing(memberId, groupId);
      return { ok: false, reason: stands === "owner" ? "owner-must-hand-over" : "not-member" };
    },

    /**
     * Deletes the Group for everyone, only for its current Owner. D1 removes
     * its memberships, Invites and night state by ON DELETE CASCADE; the
     * Members' Check-ins stay, since they belong to the Members.
     */
    async deleteGroup(ownerId: number, groupId: number): Promise<GroupChangeResult> {
      // RETURNING, not meta.changes: D1 counts the cascaded rows in changes.
      const deleted = await db
        .prepare("DELETE FROM groups WHERE id = ?1 AND owner_id = ?2 RETURNING id")
        .bind(groupId, ownerId)
        .run();
      return deleted.results.length === 1 ? { ok: true } : refusal(ownerId, groupId, NOT_IN_GROUP_MESSAGE);
    },
  };
}
