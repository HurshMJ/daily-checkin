import { hashToken, randomToken } from "~/auth/crypto";
import { gameOnStatement } from "~/checkins";
import { gameNightOf } from "~/game-night";
import type { Clock } from "~/services";
import { codePoints, hasInvisible, INVISIBLE_MESSAGE, normaliseText } from "~/text-rules";

/** The longest Invite label, in code points of the NFC form. */
export const MAX_INVITE_LABEL_LENGTH = 40;

/** The label as it is stored: trimmed and NFC-normalised, or null when left blank. */
export function normaliseInviteLabel(raw: string): string | null {
  const label = normaliseText(raw);
  return label === "" ? null : label;
}

/** Returns an error message for a normalised label, or null when it is fine. */
export function inviteLabelError(label: string | null): string | null {
  if (label === null) return null;
  if (codePoints(label) > MAX_INVITE_LABEL_LENGTH) return `Use at most ${MAX_INVITE_LABEL_LENGTH} characters.`;
  if (hasInvisible(label)) return INVISIBLE_MESSAGE;
  return null;
}

export type MakeInviteResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not-owner" }
  | { ok: false; reason: "label"; error: string; label: string };

export type CancelInviteResult = { ok: true } | { ok: false; reason: "not-owner" | "not-pending" };

/** A pending Invite as its Owner sees it: never its token or link. */
export interface PendingInvite {
  id: number;
  label: string | null;
  createdAt: string;
}

/**
 * What an Invite link shows. Used, cancelled and unknown tokens are one
 * answer, so the page never tells them apart. `inviterName` is null once the
 * Member who made it has deleted their login. `alreadyMember` says whether
 * the viewer, when one is given, is in the Group already.
 */
export type InviteView =
  | { usable: false }
  | { usable: true; groupId: number; groupName: string; inviterName: string | null; alreadyMember: boolean };

export type JoinResult = "joined" | "already-member" | "unusable";

/** The one usable rule, for the invites row named `table`: neither used nor cancelled. An Invite never expires. */
function usable(table: string): string {
  return `${table}.used_at IS NULL AND ${table}.cancelled_at IS NULL`;
}

/**
 * The one claim on an Invite: marks it used, only while it is usable. With a
 * `memberId`, it also claims nothing when that Member is in the Group already,
 * so a Member who is already in never uses up the Invite. Every write that
 * joins a Group follows it in the same D1 batch, gated on `changes() = 1`.
 */
export function claimInviteStatement(
  db: D1Database,
  tokenHash: string,
  nowIso: string,
  memberId?: number,
): D1PreparedStatement {
  if (memberId === undefined) {
    return db
      .prepare(`UPDATE invites SET used_at = ?1 WHERE token_hash = ?2 AND ${usable("invites")}`)
      .bind(nowIso, tokenHash);
  }
  return db
    .prepare(
      `UPDATE invites SET used_at = ?1 WHERE token_hash = ?2 AND ${usable("invites")}
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.group_id = invites.group_id AND m.member_id = ?3)`,
    )
    .bind(nowIso, tokenHash, memberId);
}

/**
 * Adds the Member to the Invite's Group, only when the statement just before
 * it in the batch changed one row (`changes() = 1`): the claim itself, or an
 * insert that is itself gated on the claim. A new Member is found by the
 * lower-cased username the same batch inserted.
 */
export function joinMembershipStatement(
  db: D1Database,
  tokenHash: string,
  nowIso: string,
  member: { id: number } | { usernameLower: string },
): D1PreparedStatement {
  if ("id" in member) {
    return db
      .prepare(
        `INSERT INTO memberships (group_id, member_id, joined_at)
         SELECT group_id, ?3, ?2 FROM invites WHERE token_hash = ?1 AND changes() = 1`,
      )
      .bind(tokenHash, nowIso, member.id);
  }
  return db
    .prepare(
      `INSERT INTO memberships (group_id, member_id, joined_at)
       SELECT i.group_id, m.id, ?2 FROM invites i JOIN members m ON m.username_lower = ?3
       WHERE i.token_hash = ?1 AND changes() = 1`,
    )
    .bind(tokenHash, nowIso, member.usernameLower);
}

/**
 * Everything an existing Member's join writes, in batch order: the claim, the
 * membership gated on it, and the Game On statement, so the Member's Yes for
 * tonight counts at once. The Game On statement only ever marks a Group that
 * really has its threshold of Yes answers, so it needs no gate.
 */
export function joinStatements(db: D1Database, memberId: number, tokenHash: string, now: Date): D1PreparedStatement[] {
  const nowIso = now.toISOString();
  return [
    claimInviteStatement(db, tokenHash, nowIso, memberId),
    joinMembershipStatement(db, tokenHash, nowIso, { id: memberId }),
    gameOnStatement(db, memberId, gameNightOf(now)),
  ];
}

/**
 * Invites: the Owner makes, lists and cancels them, and anyone with a link
 * joins the Group with it once. On D1 and the injected clock. The token
 * leaves this module only in the make result, for the Owner to copy; D1 sees
 * its hash.
 */
export function createInvites({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;

  async function isOwner(memberId: number, groupId: number): Promise<boolean> {
    const row = await db
      .prepare("SELECT 1 FROM groups WHERE id = ?1 AND owner_id = ?2")
      .bind(groupId, memberId)
      .first();
    return row !== null;
  }

  /**
   * What the Invite page shows for a token. The inviter is named by their
   * username until ticket 24 adds Display Names, read at view time so a
   * rename shows at once.
   */
  async function inviteFor(token: string, viewerId: number | null = null): Promise<InviteView> {
    const row = await db
      .prepare(
        `SELECT g.id, g.name, p.username AS inviter,
                EXISTS (SELECT 1 FROM memberships m WHERE m.group_id = g.id AND m.member_id = ?2) AS already
         FROM invites i JOIN groups g ON g.id = i.group_id
         LEFT JOIN members p ON p.id = i.created_by
         WHERE i.token_hash = ?1 AND ${usable("i")}`,
      )
      .bind(await hashToken(token), viewerId)
      .first<{ id: number; name: string; inviter: string | null; already: number }>();
    if (!row) return { usable: false };
    return {
      usable: true,
      groupId: row.id,
      groupName: row.name,
      inviterName: row.inviter,
      alreadyMember: row.already === 1,
    };
  }

  return {
    /**
     * Makes an Invite to the Group, only for its current Owner. The owner
     * check and the insert are one statement, so an Owner change between
     * them cannot slip an Invite through.
     */
    async makeInvite(ownerId: number, groupId: number, rawLabel: string): Promise<MakeInviteResult> {
      const label = normaliseInviteLabel(rawLabel);
      const error = inviteLabelError(label);
      if (error) return { ok: false, reason: "label", error, label: label ?? "" };

      const token = randomToken();
      const result = await db
        .prepare(
          `INSERT INTO invites (token_hash, group_id, created_by, label, created_at)
           SELECT ?1, id, ?2, ?3, ?4 FROM groups WHERE id = ?5 AND owner_id = ?2`,
        )
        .bind(await hashToken(token), ownerId, label, clock.now().toISOString(), groupId)
        .run();
      if (result.meta.changes !== 1) return { ok: false, reason: "not-owner" };
      return { ok: true, token };
    },

    /** The Group's pending Invites, newest first, for its Owner; null for anyone else. */
    async pendingInvites(ownerId: number, groupId: number): Promise<PendingInvite[] | null> {
      const [owner, rows] = await db.batch<Record<string, unknown>>([
        db.prepare("SELECT 1 FROM groups WHERE id = ?1 AND owner_id = ?2").bind(groupId, ownerId),
        db
          .prepare(
            `SELECT i.id, i.label, i.created_at FROM invites i JOIN groups g ON g.id = i.group_id
             WHERE i.group_id = ?1 AND g.owner_id = ?2 AND ${usable("i")}
             ORDER BY i.created_at DESC, i.id DESC`,
          )
          .bind(groupId, ownerId),
      ]);
      if (owner.results.length === 0) return null;
      return (rows.results as { id: number; label: string | null; created_at: string }[]).map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.created_at,
      }));
    },

    /** Cancels one pending Invite of the Group, only for its current Owner. */
    async cancelInvite(ownerId: number, groupId: number, inviteId: number): Promise<CancelInviteResult> {
      if (!(await isOwner(ownerId, groupId))) return { ok: false, reason: "not-owner" };
      const result = await db
        .prepare(
          `UPDATE invites SET cancelled_at = ?1 WHERE id = ?2 AND group_id = ?3 AND ${usable("invites")}
           AND EXISTS (SELECT 1 FROM groups WHERE id = ?3 AND owner_id = ?4)`,
        )
        .bind(clock.now().toISOString(), inviteId, groupId, ownerId)
        .run();
      return result.meta.changes === 1 ? { ok: true } : { ok: false, reason: "not-pending" };
    },

    inviteFor,

    /**
     * Joins an existing Member to the Invite's Group: the claim, the
     * membership and the Game On statement in one D1 batch, which is one
     * transaction, so two racing uses never both join. A Member already in
     * the Group leaves the Invite unused.
     */
    async joinWithInvite(memberId: number, token: string): Promise<JoinResult> {
      const tokenHash = await hashToken(token);
      const [claim] = await db.batch(joinStatements(db, memberId, tokenHash, clock.now()));
      if (claim.meta.changes === 1) return "joined";

      const view = await inviteFor(token, memberId);
      return view.usable && view.alreadyMember ? "already-member" : "unusable";
    },
  };
}

export type Invites = ReturnType<typeof createInvites>;
