import type { Clock, PushSubscription } from "~/services";

/** Every notification type a Member can turn on or off, in the order the profile lists their toggles. */
export const NOTIFICATION_TYPES = ["said_yes", "game_on", "game_off", "reminder", "daily_summary"] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The types a Member's change sends; the hourly run sends the others. */
export type EventType = Extract<NotificationType, "said_yes" | "game_on" | "game_off">;

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** The longest endpoint the server stores, in characters. */
export const MAX_ENDPOINT_LENGTH = 2048;

/**
 * The push services the Worker will post to. An endpoint on any other host is
 * refused, so a Member cannot make the Worker send requests to any URL.
 * A leading dot allows every subdomain of the name.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
];

function isPushHost(hostname: string): boolean {
  return PUSH_HOSTS.some((host) => (host.startsWith(".") ? hostname.endsWith(host) : hostname === host));
}

/** Decodes unpadded base64url, or returns null when the text is not base64url. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodesTo(text: string, bytes: number): boolean {
  return decodeBase64Url(text)?.length === bytes;
}

/**
 * Checks a subscription the browser sent. The browser is a trust boundary:
 * only an https endpoint of at most 2048 characters on a known push service,
 * with a 65-byte p256dh key and a 16-byte auth secret in base64url, is
 * accepted. Returns the subscription to store, or null.
 */
export function validateSubscription(fields: {
  endpoint: unknown;
  p256dh: unknown;
  auth: unknown;
}): PushSubscription | null {
  const { endpoint, p256dh, auth } = fields;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (endpoint.length > MAX_ENDPOINT_LENGTH || !URL.canParse(endpoint)) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (!isPushHost(url.hostname)) return null;
  if (!decodesTo(p256dh, 65) || !decodesTo(auth, 16)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** A Member's notification toggles: every type, with a missing row as on. */
export type NotificationPrefs = Record<NotificationType, boolean>;

/** Push subscriptions and notification toggles, on D1 and the injected clock. */
export function createPush({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;

  return {
    /**
     * Stores the device's subscription for the Member and the session that
     * turned push on. A session holds at most one subscription, so a new
     * endpoint replaces the session's old one. An endpoint that is already
     * stored moves to this Member and session, so a shared device only ever
     * reaches whoever turned it on last. Both statements run in one D1 batch,
     * so a failure cannot leave the session with no subscription.
     */
    async saveSubscription(memberId: number, sessionTokenHash: string, subscription: PushSubscription): Promise<void> {
      await db.batch([
        db
          .prepare("DELETE FROM push_subscriptions WHERE session_token_hash = ?1 AND endpoint <> ?2")
          .bind(sessionTokenHash, subscription.endpoint),
        db
          .prepare(
            `INSERT INTO push_subscriptions (endpoint, member_id, session_token_hash, p256dh, auth, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (endpoint) DO UPDATE SET member_id = excluded.member_id,
               session_token_hash = excluded.session_token_hash, p256dh = excluded.p256dh,
               auth = excluded.auth, created_at = excluded.created_at`,
          )
          .bind(
            subscription.endpoint,
            memberId,
            sessionTokenHash,
            subscription.keys.p256dh,
            subscription.keys.auth,
            clock.now().toISOString(),
          ),
      ]);
    },

    /** Deletes one of the Member's own subscriptions: Turn off on this device. */
    async deleteSubscription(memberId: number, endpoint: string): Promise<void> {
      await db
        .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND member_id = ?2")
        .bind(endpoint, memberId)
        .run();
    },

    /** Whether the session has turned push on, so the profile can say so. */
    async sessionHasSubscription(sessionTokenHash: string): Promise<boolean> {
      const row = await db
        .prepare("SELECT 1 FROM push_subscriptions WHERE session_token_hash = ?1 LIMIT 1")
        .bind(sessionTokenHash)
        .first();
      return row !== null;
    },

    /** The Member's toggles for every type; a type never set is on. */
    async prefsFor(memberId: number): Promise<NotificationPrefs> {
      const { results } = await db
        .prepare("SELECT type, enabled FROM notification_prefs WHERE member_id = ?1")
        .bind(memberId)
        .all<{ type: NotificationType; enabled: number }>();
      const prefs = Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, true])) as NotificationPrefs;
      for (const row of results) prefs[row.type] = row.enabled === 1;
      return prefs;
    },

    /** Turns each given type on or off for the Member, all in one D1 batch. */
    async setPrefs(memberId: number, prefs: Partial<NotificationPrefs>): Promise<void> {
      const statements = Object.entries(prefs).map(([type, enabled]) =>
        db
          .prepare(
            `INSERT INTO notification_prefs (member_id, type, enabled) VALUES (?1, ?2, ?3)
             ON CONFLICT (member_id, type) DO UPDATE SET enabled = excluded.enabled`,
          )
          .bind(memberId, type, enabled ? 1 : 0),
      );
      if (statements.length > 0) await db.batch(statements);
    },
  };
}

export type Push = ReturnType<typeof createPush>;
