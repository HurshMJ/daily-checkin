import type { Clock } from "~/services";

import {
  hashPassword,
  hashToken,
  iterationsFromEnv,
  randomToken,
  verifyPassword,
} from "./crypto";
import type { AvatarColour } from "./palette";
import { type NewLoginForm, usernameKey } from "./rules";

/** A session lasts this long after the Member's latest request. */
export const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** The logged-in Member a request belongs to. */
export interface CurrentMember {
  id: number;
  username: string;
  colour: AvatarColour;
}

export type CreateLoginResult =
  | { ok: true; sessionToken: string }
  | { ok: false; reason: "link-unusable" | "username-taken" };

// Run against unknown usernames so a login attempt costs the same PBKDF2 work
// whether or not the username exists.
const DUMMY_HASH = { hash: "0".repeat(64), salt: "0".repeat(32) };

/**
 * Logins, sessions and Setup Links, on D1 and the injected clock. Raw tokens
 * leave this module only to go into a cookie; D1 sees their hashes.
 */
export function createAuth({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;

  function sessionExpiry(now: Date): string {
    return new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
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
      const nowIso = now.toISOString();
      const key = usernameKey(form.username);

      const taken = await db.prepare("SELECT 1 FROM members WHERE username_lower = ?1").bind(key).first();
      if (taken) return { ok: false, reason: "username-taken" };

      const password = await hashPassword(form.password, iterationsFromEnv(env.PBKDF2_ITERATIONS));
      const sessionToken = randomToken();

      let claimed: D1Result[];
      try {
        claimed = await db.batch([
          db
            .prepare(
              "UPDATE setup_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > ?1",
            )
            .bind(nowIso, await hashToken(token)),
          db
            .prepare(
              `INSERT INTO members (username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
               SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`,
            )
            .bind(form.username, key, form.colour, password.hash, password.salt, password.iterations, nowIso),
          db
            .prepare(
              `INSERT INTO sessions (token_hash, member_id, expires_at, created_at)
               SELECT ?1, id, ?2, ?3 FROM members WHERE username_lower = ?4 AND changes() = 1`,
            )
            .bind(await hashToken(sessionToken), sessionExpiry(now), nowIso, key),
        ]);
      } catch (error) {
        // Someone took the username between the check above and the batch.
        if (String(error).includes("UNIQUE constraint failed: members.username_lower")) {
          return { ok: false, reason: "username-taken" };
        }
        throw error;
      }
      if (claimed[0].meta.changes !== 1) return { ok: false, reason: "link-unusable" };
      return { ok: true, sessionToken };
    },

    /**
     * Checks a username in any casing and a password. Returns a new session
     * token, or null without saying which part was wrong.
     */
    async logIn(username: string, password: string): Promise<string | null> {
      const row = await db
        .prepare(
          "SELECT id, password_hash, password_salt, password_iterations FROM members WHERE username_lower = ?1",
        )
        .bind(usernameKey(username))
        .first<{ id: number; password_hash: string; password_salt: string; password_iterations: number }>();

      if (!row) {
        await verifyPassword(password, {
          ...DUMMY_HASH,
          iterations: iterationsFromEnv(env.PBKDF2_ITERATIONS),
        });
        return null;
      }
      const matches = await verifyPassword(password, {
        hash: row.password_hash,
        salt: row.password_salt,
        iterations: row.password_iterations,
      });
      if (!matches) return null;

      const now = clock.now();
      const sessionToken = randomToken();
      await db
        .prepare("INSERT INTO sessions (token_hash, member_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(await hashToken(sessionToken), row.id, sessionExpiry(now), now.toISOString())
        .run();
      return sessionToken;
    },

    /**
     * Finds the Member a session token belongs to and pushes its expiry to 90
     * days from now. An expired or unknown token gives null.
     */
    async resolveSession(token: string): Promise<CurrentMember | null> {
      const now = clock.now();
      const tokenHash = await hashToken(token);
      const [, found] = await db.batch<CurrentMember>([
        db
          .prepare("UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2 AND expires_at > ?3")
          .bind(sessionExpiry(now), tokenHash, now.toISOString()),
        db
          .prepare(
            `SELECT m.id, m.username, m.colour FROM sessions s JOIN members m ON m.id = s.member_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
          )
          .bind(tokenHash, now.toISOString()),
      ]);
      return found.results[0] ?? null;
    },

    /** Ends one session: Log out on this device. */
    async endSession(token: string): Promise<void> {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await hashToken(token)).run();
    },

    /** Ends every session of a Member: Log out everywhere. */
    async endAllSessions(memberId: number): Promise<void> {
      await db.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(memberId).run();
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
