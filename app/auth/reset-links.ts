import type { Clock } from "~/services";

import { hashPassword, hashToken, iterationsFromEnv, randomToken } from "./crypto";
import { createLoginLimits } from "./login-limits";
import { RESET_LINK_LIFETIME_MS, usableResetLink } from "./reset-link-sql";
import { normalisePassword, passwordError, usernameKey } from "./rules";

export type MakeResetLinkResult = { ok: true; token: string } | { ok: false; reason: "not-allowed" };

export type CancelResetLinkResult = { ok: true } | { ok: false; reason: "not-pending" };

export type SetPasswordResult =
  | { ok: true }
  | { ok: false; reason: "unusable" }
  | { ok: false; reason: "password"; message: string };

/** A usable link its maker made for a Member of the Group, as the Group page shows it: never its token. */
export interface PendingResetLink {
  memberId: number;
  expiresAt: string;
}

/** Who a usable link is for, as the /reset page shows it. */
export interface ResetLinkView {
  username: string;
}

/**
 * Password Reset Links: an Owner makes, lists and cancels them for the
 * Members of their Groups, and whoever opens one sets that Member's password
 * once. On D1 and the injected clock. The token leaves this module only in
 * the make result, for the Owner to copy; D1 sees its hash. The Operator's
 * links come from scripts/reset-link.ts through reset-link-sql.ts.
 */
export function createResetLinks({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;
  const limits = createLoginLimits({ db, clock });

  /**
   * True in SQL when Member ?1 may make a link for Member ?2: ?1 owns a Group
   * that ?2 is in, and ?2 is someone else, who would use Change password.
   */
  const MAY_MAKE = `?2 != ?1 AND EXISTS (
    SELECT 1 FROM groups g JOIN memberships m ON m.group_id = g.id WHERE g.owner_id = ?1 AND m.member_id = ?2
  )`;

  async function linkFor(tokenHash: string, nowIso: string) {
    return db
      .prepare(
        `SELECT l.member_id, m.username FROM password_reset_links l JOIN members m ON m.id = l.member_id
         WHERE l.token_hash = ?1 AND ${usableResetLink("l", "?2")}`,
      )
      .bind(tokenHash, nowIso)
      .first<{ member_id: number; username: string }>();
  }

  return {
    /**
     * Makes a link for a Member, only for a current Owner of a Group they are
     * in. Every older usable link of the Member, whoever made it, is
     * cancelled and the new one inserted in one D1 batch, each gated on the
     * same check, so an Owner change between them cannot slip a link through.
     */
    async make(makerId: number, memberId: number): Promise<MakeResetLinkResult> {
      const now = clock.now();
      const nowIso = now.toISOString();
      const token = randomToken();
      const [, inserted] = await db.batch([
        db
          .prepare(
            `UPDATE password_reset_links SET cancelled_at = ?3
             WHERE member_id = ?2 AND ${usableResetLink("password_reset_links", "?3")} AND ${MAY_MAKE}`,
          )
          .bind(makerId, memberId, nowIso),
        db
          .prepare(
            `INSERT INTO password_reset_links (token_hash, member_id, made_by, created_at, expires_at)
             SELECT ?3, ?2, ?1, ?4, ?5 WHERE ${MAY_MAKE}`,
          )
          .bind(
            makerId,
            memberId,
            await hashToken(token),
            nowIso,
            new Date(now.getTime() + RESET_LINK_LIFETIME_MS).toISOString(),
          ),
      ]);
      if (inserted.meta.changes !== 1) return { ok: false, reason: "not-allowed" };
      return { ok: true, token };
    },

    /**
     * The usable links the maker made for the Group's Members, for the
     * Group's Owner; null when the maker does not own the Group.
     */
    async pending(makerId: number, groupId: number): Promise<PendingResetLink[] | null> {
      const nowIso = clock.now().toISOString();
      const [owner, rows] = await db.batch<Record<string, unknown>>([
        db.prepare("SELECT 1 FROM groups WHERE id = ?1 AND owner_id = ?2").bind(groupId, makerId),
        db
          .prepare(
            `SELECT l.member_id, l.expires_at FROM password_reset_links l
             JOIN memberships m ON m.member_id = l.member_id AND m.group_id = ?1
             WHERE l.made_by = ?2 AND ${usableResetLink("l", "?3")}
             ORDER BY l.created_at`,
          )
          .bind(groupId, makerId, nowIso),
      ]);
      if (owner.results.length === 0) return null;
      return (rows.results as { member_id: number; expires_at: string }[]).map((row) => ({
        memberId: row.member_id,
        expiresAt: row.expires_at,
      }));
    },

    /**
     * Cancels the usable links the maker made for a Member. Only the maker
     * can: a link made by someone else, or by the Operator, is untouched.
     */
    async cancel(makerId: number, memberId: number): Promise<CancelResetLinkResult> {
      const nowIso = clock.now().toISOString();
      const result = await db
        .prepare(
          `UPDATE password_reset_links SET cancelled_at = ?3
           WHERE made_by = ?1 AND member_id = ?2 AND ${usableResetLink("password_reset_links", "?3")}`,
        )
        .bind(makerId, memberId, nowIso)
        .run();
      return result.meta.changes > 0 ? { ok: true } : { ok: false, reason: "not-pending" };
    },

    /** Who a usable link is for; null for a used, cancelled, expired or unknown token alike. */
    async view(token: string): Promise<ResetLinkView | null> {
      const row = await linkFor(await hashToken(token), clock.now().toISOString());
      return row ? { username: row.username } : null;
    },

    /**
     * Sets the Member's password through a usable link, under the password
     * rules of Change password. One D1 batch, which is one transaction,
     * claims the link, stores the new hash with the notice flag, ends every
     * session of the Member (their push subscriptions go by cascade) and
     * clears the username's login failures. The claim is conditional and each
     * write after it runs only when the one before it changed one row
     * (`changes() = 1`), so two racing uses cannot both set a password. The
     * Member is not logged in.
     */
    async setPassword(token: string, typedPassword: string): Promise<SetPasswordResult> {
      const tokenHash = await hashToken(token);
      const now = clock.now().toISOString();
      const link = await linkFor(tokenHash, now);
      if (!link) return { ok: false, reason: "unusable" };

      const password = normalisePassword(typedPassword);
      const problem = passwordError(password, link.username);
      if (problem) return { ok: false, reason: "password", message: problem };

      const hashed = await hashPassword(password, iterationsFromEnv(env.PBKDF2_ITERATIONS));
      const [claim] = await db.batch([
        db
          .prepare(
            `UPDATE password_reset_links SET used_at = ?1
             WHERE token_hash = ?2 AND member_id = ?3 AND ${usableResetLink("password_reset_links", "?1")}`,
          )
          .bind(now, tokenHash, link.member_id),
        db
          .prepare(
            `UPDATE members SET password_hash = ?1, password_salt = ?2, password_iterations = ?3, password_reset_notice = 1
             WHERE id = ?4 AND changes() = 1`,
          )
          .bind(hashed.hash, hashed.salt, hashed.iterations, link.member_id),
        db.prepare("DELETE FROM sessions WHERE member_id = ?1 AND changes() = 1").bind(link.member_id),
        // Harmless when the claim lost a race: only a usable link got this far.
        limits.clearUsername(usernameKey(link.username)),
      ]);
      return claim.meta.changes === 1 ? { ok: true } : { ok: false, reason: "unusable" };
    },
  };
}

export type ResetLinks = ReturnType<typeof createResetLinks>;
