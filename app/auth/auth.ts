import { deleteGroupsOwnedAloneStatement, type OwnedGroup, ownedGroupsWithOthers } from "~/groups";
import { claimInviteStatement, joinMembershipStatement } from "~/invites";
import type { Clock } from "~/services";

import {
  hashPassword,
  hashToken,
  iterationsFromEnv,
  randomToken,
  verifyPassword,
} from "./crypto";
import { createLoginLimits } from "./login-limits";
import type { AvatarColour } from "./palette";
import {
  nameKey,
  type NewLoginForm,
  normalisePassword,
  normaliseUsername,
  passwordError,
  passwordTooLong,
  type ProfileNamesErrors,
  type ProfileNamesForm,
  USERNAME_IS_PASSWORD_MESSAGE,
  USERNAME_TAKEN_MESSAGE,
  usernameKey,
  usernameTooLong,
} from "./rules";

/** A session lasts this long after the Member's latest request. */
export const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** The logged-in Member a request belongs to. */
export interface CurrentMember {
  id: number;
  username: string;
  /** Null when the Member has not chosen one and shows their username. */
  displayName: string | null;
  colour: AvatarColour;
  /**
   * True when a Password Reset Link set the password and the Member has not
   * yet seen the "your password was reset" notice.
   */
  passwordWasReset: boolean;
  /**
   * True when the Operator has allowed the Member to create Groups. Owning a
   * Group by hand-over does not set it.
   */
  canCreateGroups: boolean;
}

export type CreateLoginResult =
  | { ok: true; sessionToken: string }
  | { ok: false; reason: "link-unusable" | "username-taken" };

export type SaveProfileNamesResult = { ok: true } | { ok: false; errors: ProfileNamesErrors };

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: "limited" | "wrong-current" }
  | { ok: false; reason: "new-password"; message: string };

export type DeleteLoginResult =
  | { ok: true }
  | { ok: false; reason: "limited" | "wrong-password" }
  | { ok: false; reason: "owns-groups"; groups: OwnedGroup[] };

// D1's message when deleting a Member who still owns a Group.
const FOREIGN_KEY_FAILED = /FOREIGN KEY constraint failed/;

// D1's message when an insert or update hits a name another Member holds:
// the name_keys primary key, or the login key on members.
const NAME_TAKEN = /UNIQUE constraint failed: (name_keys\.name_key|members\.username_lower)/;

// Run against unknown usernames so a login attempt costs the same PBKDF2 work
// whether or not the username exists.
const DUMMY_HASH = { hash: "0".repeat(64), salt: "0".repeat(32) };

/**
 * Logins, sessions, Setup Links and creating a login from an Invite, on D1
 * and the injected clock. Raw tokens leave this module only to go into a
 * cookie; D1 sees their hashes.
 */
export function createAuth({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;
  const limits = createLoginLimits({ db, clock });

  function sessionExpiry(now: Date): string {
    return new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
  }

  /**
   * True when a normalised password matches the Member's stored hash. One
   * PBKDF2 run; a password longer than any login can have costs no lookup.
   */
  async function isStoredPassword(memberId: number, password: string): Promise<boolean> {
    if (passwordTooLong(password)) return false;
    const row = await db
      .prepare("SELECT password_hash, password_salt, password_iterations FROM members WHERE id = ?1")
      .bind(memberId)
      .first<{ password_hash: string; password_salt: string; password_iterations: number }>();
    return (
      row !== null &&
      (await verifyPassword(password, { hash: row.password_hash, salt: row.password_salt, iterations: row.password_iterations }))
    );
  }

  /** Ends every session of a Member except the one with this token. */
  async function endOtherSessionsStatement(memberId: number, keepToken: string): Promise<D1PreparedStatement> {
    return db
      .prepare("DELETE FROM sessions WHERE member_id = ?1 AND token_hash != ?2")
      .bind(memberId, await hashToken(keepToken));
  }

  /**
   * Creates a Member and their first session after `claim`, a link's claim
   * statement, in one D1 batch, which is one transaction. Each insert runs
   * only when the statement before it changed one row (`changes() = 1`), so
   * nothing is written unless the claim succeeded and two racing uses cannot
   * both succeed. `then` runs after the session, gated the same way.
   */
  async function createLoginAfterClaim(
    now: Date,
    form: NewLoginForm,
    claim: D1PreparedStatement,
    then: D1PreparedStatement[],
  ): Promise<CreateLoginResult> {
    const nowIso = now.toISOString();
    const key = usernameKey(form.username);

    const taken = await db.prepare("SELECT 1 FROM name_keys WHERE name_key = ?1").bind(key).first();
    if (taken) return { ok: false, reason: "username-taken" };

    const password = await hashPassword(form.password, iterationsFromEnv(env.PBKDF2_ITERATIONS));
    const sessionToken = randomToken();

    let claimed: D1Result[];
    try {
      claimed = await db.batch([
        claim,
        db
          .prepare(
            `INSERT INTO members (username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
          )
          .bind(form.username, key, form.colour, password.hash, password.salt, password.iterations, nowIso),
        db
          .prepare(
            `INSERT INTO name_keys (name_key, member_id)
             SELECT ?1, id FROM members WHERE username_lower = ?1 AND changes() = 1`,
          )
          .bind(key),
        db
          .prepare(
            `INSERT INTO sessions (token_hash, member_id, expires_at, created_at)
             SELECT ?1, id, ?2, ?3 FROM members WHERE username_lower = ?4 AND changes() = 1`,
          )
          .bind(await hashToken(sessionToken), sessionExpiry(now), nowIso, key),
        ...then,
      ]);
    } catch (error) {
      // Someone took the name, as a username or a Display Name, between the
      // check above and the batch.
      if (NAME_TAKEN.test(String(error))) {
        return { ok: false, reason: "username-taken" };
      }
      throw error;
    }
    if (claimed[0].meta.changes !== 1) return { ok: false, reason: "link-unusable" };
    return { ok: true, sessionToken };
  }

  return {
    /** True when the Setup Link is not used, not cancelled and not expired. */
    async setupLinkIsUsable(token: string): Promise<boolean> {
      const row = await db
        .prepare(
          "SELECT 1 FROM setup_links WHERE token_hash = ?1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?2",
        )
        .bind(await hashToken(token), clock.now().toISOString())
        .first();
      return row !== null;
    },

    /**
     * Uses a Setup Link to create a Member and log them in. The link is marked
     * used, the Member inserted and the session started in one D1 batch, which
     * is one transaction: the inserts run only when the UPDATE claimed the
     * link (`changes() = 1`), so two racing uses cannot both succeed.
     */
    async createLoginFromSetupLink(token: string, form: NewLoginForm): Promise<CreateLoginResult> {
      const now = clock.now();
      const claim = db
        .prepare(
          "UPDATE setup_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?1",
        )
        .bind(now.toISOString(), await hashToken(token));
      return createLoginAfterClaim(now, form, claim, []);
    },

    /**
     * Uses an Invite to create a Member, log them in and join them to the
     * Invite's Group, in one D1 batch gated on the Invite's claim like a Setup
     * Link. A new Member has no Check-in yet, so joining cannot change Game On.
     */
    async createLoginFromInvite(token: string, form: NewLoginForm): Promise<CreateLoginResult> {
      const now = clock.now();
      const nowIso = now.toISOString();
      const tokenHash = await hashToken(token);
      return createLoginAfterClaim(now, form, claimInviteStatement(db, tokenHash, nowIso), [
        joinMembershipStatement(db, tokenHash, nowIso, { usernameLower: usernameKey(form.username) }),
      ]);
    },

    /**
     * Checks a username in any casing and a password, within the login limits
     * for the username and the client IP. Returns a new session token, or null
     * without saying which part was wrong or whether a limit refused it. A
     * refused attempt, or a username or password longer than any login can
     * have, costs no lookup or PBKDF2 work; an over-long username records an
     * IP failure only, so no stored key is longer than a username. A
     * successful login clears the username's failures.
     */
    async logIn(username: string, typedPassword: string, ip: string): Promise<string | null> {
      const key = usernameKey(username);
      if (!(await limits.admit(key, ip))) return null;
      if (usernameTooLong(normaliseUsername(username))) {
        await limits.recordIpFailure(ip);
        return null;
      }

      const password = normalisePassword(typedPassword);
      if (passwordTooLong(password)) {
        await limits.recordFailure(key, ip);
        return null;
      }

      const row = await db
        .prepare(
          "SELECT id, password_hash, password_salt, password_iterations FROM members WHERE username_lower = ?1",
        )
        .bind(key)
        .first<{ id: number; password_hash: string; password_salt: string; password_iterations: number }>();

      const matches = await verifyPassword(
        password,
        row
          ? { hash: row.password_hash, salt: row.password_salt, iterations: row.password_iterations }
          : { ...DUMMY_HASH, iterations: iterationsFromEnv(env.PBKDF2_ITERATIONS) },
      );
      if (!row || !matches) {
        await limits.recordFailure(key, ip);
        return null;
      }

      const now = clock.now();
      const sessionToken = randomToken();
      await db.batch([
        db
          .prepare("INSERT INTO sessions (token_hash, member_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
          .bind(await hashToken(sessionToken), row.id, sessionExpiry(now), now.toISOString()),
        limits.clearUsername(key),
      ]);
      return sessionToken;
    },

    /**
     * Changes a Member's password after checking the current one, within the
     * same login limits as logging in: a wrong current password counts as a
     * failed login, and a locked username or limited IP is refused. On success
     * the new hash is stored, the username's failures are cleared and every
     * other session of the Member ends, in one D1 batch; the session with
     * `keepToken` stays.
     */
    async changePassword(
      member: CurrentMember,
      keepToken: string,
      typedCurrent: string,
      typedNew: string,
      ip: string,
    ): Promise<ChangePasswordResult> {
      const key = usernameKey(member.username);
      if (!(await limits.admit(key, ip))) return { ok: false, reason: "limited" };

      if (!(await isStoredPassword(member.id, normalisePassword(typedCurrent)))) {
        await limits.recordFailure(key, ip);
        return { ok: false, reason: "wrong-current" };
      }

      const next = normalisePassword(typedNew);
      const problem = passwordError(next, member.username);
      if (problem) return { ok: false, reason: "new-password", message: problem };

      const hashed = await hashPassword(next, iterationsFromEnv(env.PBKDF2_ITERATIONS));
      await db.batch([
        db
          .prepare(
            "UPDATE members SET password_hash = ?1, password_salt = ?2, password_iterations = ?3 WHERE id = ?4",
          )
          .bind(hashed.hash, hashed.salt, hashed.iterations, member.id),
        limits.clearUsername(key),
        await endOtherSessionsStatement(member.id, keepToken),
      ]);
      return { ok: true };
    },

    /**
     * Deletes a Member's login after checking their password, within the same
     * login limits as logging in: a wrong password counts as a failed login,
     * and a locked username or limited IP is refused before any PBKDF2 work.
     * A Member who owns a Group with anyone else in it is refused with those
     * Groups. Otherwise one D1 batch, which is one transaction, deletes the
     * Groups they own alone, their username's login failures and their
     * members row; ON DELETE CASCADE erases their sessions, push
     * subscriptions, memberships, Check-ins, History rows, notification
     * toggles, name keys and Password Reset Links, so their names are free at
     * once. A Group gaining a Member between the check and the batch fails the
     * groups.owner_id foreign key and rolls the batch back. Nobody is notified.
     */
    async deleteLogin(member: CurrentMember, typedPassword: string, ip: string): Promise<DeleteLoginResult> {
      const key = usernameKey(member.username);
      if (!(await limits.admit(key, ip))) return { ok: false, reason: "limited" };

      if (!(await isStoredPassword(member.id, normalisePassword(typedPassword)))) {
        await limits.recordFailure(key, ip);
        return { ok: false, reason: "wrong-password" };
      }

      const owned = await ownedGroupsWithOthers(db, member.id);
      if (owned.length > 0) return { ok: false, reason: "owns-groups", groups: owned };
      try {
        await db.batch([
          deleteGroupsOwnedAloneStatement(db, member.id),
          limits.clearUsername(key),
          db.prepare("DELETE FROM members WHERE id = ?1").bind(member.id),
        ]);
      } catch (error) {
        if (!FOREIGN_KEY_FAILED.test(String(error))) throw error;
        return { ok: false, reason: "owns-groups", groups: await ownedGroupsWithOthers(db, member.id) };
      }
      return { ok: true };
    },

    /**
     * Saves a Member's username, Display Name and avatar colour from the
     * profile, in one D1 batch: the Member's name_keys rows are deleted, the
     * username key and (when set and different) the Display Name key are
     * inserted, and members is updated. The name_keys primary key is the only
     * guard on a name another Member holds, so two racing renames cannot both
     * take one name and a refused save changes nothing.
     *
     * When the username changes, the new username as typed is hashed once
     * with the Member's stored salt and refused if it is their password. A
     * case variant of the password is not caught (one PBKDF2 run only).
     * Because a refusal reveals the password, the check sits inside the login
     * limits: it is refused with no PBKDF2 run when `admit` refuses, and
     * every check, match or not, records an IP failure, so renames share the
     * IP budget with logins. No username failure is recorded, since each
     * accepted rename changes the username key. A save that keeps the
     * username runs no check and is never limited.
     */
    async saveProfileNames(
      member: CurrentMember,
      form: ProfileNamesForm,
      ip: string,
    ): Promise<SaveProfileNamesResult> {
      if (form.username !== member.username) {
        if (!(await limits.admit(usernameKey(member.username), ip))) {
          return { ok: false, errors: { username: "Too many tries. Try again later." } };
        }
        const isPassword = await isStoredPassword(member.id, normalisePassword(form.username));
        await limits.recordIpFailure(ip);
        if (isPassword) return { ok: false, errors: { username: USERNAME_IS_PASSWORD_MESSAGE } };
      }

      const usernameKeyValue = nameKey(form.username);
      const displayNameKey = form.displayName === null ? null : nameKey(form.displayName);
      const keys = [usernameKeyValue];
      if (displayNameKey !== null && displayNameKey !== usernameKeyValue) keys.push(displayNameKey);

      try {
        await db.batch([
          db.prepare("DELETE FROM name_keys WHERE member_id = ?1").bind(member.id),
          ...keys.map((key) =>
            db.prepare("INSERT INTO name_keys (name_key, member_id) VALUES (?1, ?2)").bind(key, member.id),
          ),
          db
            .prepare("UPDATE members SET username = ?1, username_lower = ?2, display_name = ?3, colour = ?4 WHERE id = ?5")
            .bind(form.username, usernameKeyValue, form.displayName, form.colour, member.id),
        ]);
      } catch (error) {
        if (!NAME_TAKEN.test(String(error))) throw error;
        // The batch changed nothing. Look up which of the two names another
        // Member holds only to put the message next to the right field.
        const placeholders = keys.map((_, i) => `?${i + 2}`).join(", ");
        const { results } = await db
          .prepare(`SELECT name_key FROM name_keys WHERE member_id != ?1 AND name_key IN (${placeholders})`)
          .bind(member.id, ...keys)
          .all<{ name_key: string }>();
        const displayNameClashed =
          displayNameKey !== null && results.some((row) => row.name_key === displayNameKey) &&
          !results.some((row) => row.name_key === usernameKeyValue);
        return {
          ok: false,
          errors: displayNameClashed ? { displayName: "That name is taken." } : { username: USERNAME_TAKEN_MESSAGE },
        };
      }
      return { ok: true };
    },

    /**
     * Finds the Member a session token belongs to and pushes its expiry to 90
     * days from now. An expired or unknown token gives null.
     */
    async resolveSession(token: string): Promise<CurrentMember | null> {
      const now = clock.now();
      const tokenHash = await hashToken(token);
      const [, found] = await db.batch<
        Omit<CurrentMember, "passwordWasReset" | "canCreateGroups"> & { passwordResetNotice: number; canCreateGroups: number }
      >([
        db
          .prepare("UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2 AND expires_at > ?3")
          .bind(sessionExpiry(now), tokenHash, now.toISOString()),
        db
          .prepare(
            `SELECT m.id, m.username, m.display_name AS displayName, m.colour, m.password_reset_notice AS passwordResetNotice,
                    m.can_create_groups AS canCreateGroups
             FROM sessions s JOIN members m ON m.id = s.member_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
          )
          .bind(tokenHash, now.toISOString()),
      ]);
      const row = found.results[0];
      if (!row) return null;
      const { passwordResetNotice, canCreateGroups, ...member } = row;
      return { ...member, passwordWasReset: passwordResetNotice === 1, canCreateGroups: canCreateGroups === 1 };
    },

    /**
     * Clears the Member's "your password was reset" flag. True only for the
     * one call that cleared it, so the notice shows once even when two pages
     * load at the same time.
     */
    async takePasswordResetNotice(memberId: number): Promise<boolean> {
      const result = await db
        .prepare("UPDATE members SET password_reset_notice = 0 WHERE id = ?1 AND password_reset_notice = 1")
        .bind(memberId)
        .run();
      return result.meta.changes === 1;
    },

    /** Ends one session: Log out on this device. */
    async endSession(token: string): Promise<void> {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await hashToken(token)).run();
    },

    /** Ends every session of a Member except this one: log out all other devices. */
    async endOtherSessions(memberId: number, keepToken: string): Promise<void> {
      await (await endOtherSessionsStatement(memberId, keepToken)).run();
    },

    /** Ends every session of a Member: Log out everywhere. */
    async endAllSessions(memberId: number): Promise<void> {
      await db.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(memberId).run();
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
