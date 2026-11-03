import type { AvatarColour } from "~/auth/palette";
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

/** A Group as its Members see it on the Group page. */
export interface GroupView {
  id: number;
  name: string;
  threshold: number;
  ownerId: number;
  /** Every Member, in the order they joined. */
  members: { id: number; username: string; colour: AvatarColour }[];
}

export type CreateGroupResult = { ok: true; groupId: number } | { ok: false; error: string; name: string };

/** Groups and their Members, on D1 and the injected clock. */
export function createGroups({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;

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
            `SELECT p.id, p.username, p.colour FROM memberships m JOIN members p ON p.id = m.member_id
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
        members: members.results as GroupView["members"],
      };
    },
  };
}
