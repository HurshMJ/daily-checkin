import type { EventType, NotificationType } from "~/push";
import { type Clock, PushNotConfiguredError, type PushSender, type PushSubscription } from "~/services";

/**
 * A push the database has claimed for sending: "someone said Yes" for the
 * actor, or Game On or Game Off for one Group. Each is claimed at most once
 * per Member or Group per Game Night, in the same D1 batch as the change that
 * causes it.
 */
export type NotificationEvent = { type: "said_yes" } | { type: "game_on" | "game_off"; groupId: number };

/**
 * Claim statements to append to the D1 batch of a change, after the change's
 * own statements, and how to read the events they claimed from their results.
 */
export interface Claims {
  statements: D1PreparedStatement[];
  events(results: D1Result[]): NotificationEvent[];
}

/** Claims that run one after another in the batch, in order. */
export function allClaims(...parts: Claims[]): Claims {
  return {
    statements: parts.flatMap((part) => part.statements),
    events(results) {
      let offset = 0;
      return parts.flatMap((part) => {
        const own = results.slice(offset, offset + part.statements.length);
        offset += part.statements.length;
        return part.events(own);
      });
    },
  };
}

/**
 * Runs the change's statements and the claims in one D1 batch, which is one
 * transaction, so two racing requests can never both claim the same push.
 * Returns the change's own results and the claimed events.
 */
export async function batchWithClaims(
  db: D1Database,
  statements: D1PreparedStatement[],
  claims: Claims,
): Promise<{ results: D1Result[]; events: NotificationEvent[] }> {
  const all = await db.batch([...statements, ...claims.statements]);
  return { results: all.slice(0, statements.length), events: claims.events(all.slice(statements.length)) };
}

/**
 * Claims "someone said Yes" for the Member's Check-in on the night `night`,
 * once: only while the Check-in is Yes and nothing was sent for it yet.
 * Switching away from Yes and back therefore sends nothing more.
 */
export function saidYesClaims(db: D1Database, memberId: number, night: string): Claims {
  return {
    statements: [
      db
        .prepare(
          `UPDATE checkins SET said_yes_notified = 1
           WHERE member_id = ?1 AND game_night = ?2 AND availability = 'yes' AND said_yes_notified = 0
           RETURNING member_id`,
        )
        .bind(memberId, night),
    ],
    events: ([claimed]) => (claimed.results.length > 0 ? [{ type: "said_yes" }] : []),
  };
}

/** The pushes the hourly scheduled run sends, at most once per Game Night each. */
export type ScheduledType = Extract<NotificationType, "reminder" | "daily_summary">;

/** The scheduler_state column holding the Game Night each scheduled push last claimed. */
const CLAIM_COLUMNS: Record<ScheduledType, string> = {
  reminder: "last_reminder_game_night",
  daily_summary: "last_summary_game_night",
};

/**
 * Claims the Game Night `night` for one scheduled push, on the single
 * scheduler_state row, the way the Reset claims its night. True means this
 * run owns the night and should send; false means the night, or a later one,
 * was claimed already, so nothing is sent. Creating the row leaves the
 * Reset's night NULL, as it was.
 */
export async function claimNight(db: D1Database, type: ScheduledType, night: string): Promise<boolean> {
  const column = CLAIM_COLUMNS[type];
  const claimed = await db
    .prepare(
      `INSERT INTO scheduler_state (id, ${column}) VALUES (1, ?1)
       ON CONFLICT (id) DO UPDATE SET ${column} = excluded.${column}
       WHERE scheduler_state.${column} IS NULL OR scheduler_state.${column} < excluded.${column}
       RETURNING id`,
    )
    .bind(night)
    .first();
  return claimed !== null;
}

/**
 * The longest plaintext payload a push may carry, in UTF-8 bytes. Push
 * services accept a 4096-byte encrypted body; RFC 8291 section 4 spends 86
 * bytes on the aes128gcm header (16 salt, 4 record size, 1 key length, 65
 * key), 16 on the AEAD tag and 1 on the padding delimiter: 4096 - 86 - 16 - 1.
 */
export const MAX_PAYLOAD_BYTES = 3993;

/** What the service worker shows: the notification's title and body, the page a tap opens, and its tag. */
export interface Payload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** The payload as JSON, refusing one that would not fit in a push. */
export function encodePayload(payload: Payload): string {
  const json = JSON.stringify(payload);
  if (new TextEncoder().encode(json).length > MAX_PAYLOAD_BYTES) throw new Error("Push payload too large");
  return json;
}

function yesWord(count: number): string {
  return count === 1 ? "1 said Yes" : `${count} said Yes`;
}

/**
 * The payload for each event. Names are read at send time; the Member is
 * named by username until ticket 24 adds Display Names.
 */
export function payloadFor(
  event: NotificationEvent,
  facts: { actorName: string; night: string; actorId: number; group?: { name: string; threshold: number; yes: number } },
): Payload {
  if (event.type === "said_yes") {
    return {
      title: `${facts.actorName} said Yes`,
      body: "They are in for tonight. Open Tonight to see your Boards.",
      url: "/",
      tag: `said-yes-${facts.actorId}-${facts.night}`,
    };
  }
  const group = facts.group!;
  if (event.type === "game_on") {
    return {
      title: `Game On: ${group.name}`,
      body: `${yesWord(group.yes)}, enough for tonight's game.`,
      url: `/groups/${event.groupId}`,
      tag: `game-on-${event.groupId}-${facts.night}`,
    };
  }
  return {
    title: `Game Off: ${group.name}`,
    body: `Now ${yesWord(group.yes)}, fewer than the ${group.threshold} needed.`,
    url: `/groups/${event.groupId}`,
    tag: `game-off-${event.groupId}-${facts.night}`,
  };
}

/**
 * The subscriptions an event goes to. `recipients` is a subquery of member
 * ids; on top of it every push skips the actor (?1), a Member who turned the
 * type (?2) off, and a device whose session has expired by now (?3). Each
 * subscription appears once, so a Member gets one push per device.
 */
function subscriptionsSql(recipients: string): string {
  return `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
          JOIN sessions se ON se.token_hash = s.session_token_hash AND se.expires_at > ?3
          WHERE s.member_id <> ?1 AND s.member_id IN (${recipients})
          AND NOT EXISTS (SELECT 1 FROM notification_prefs p
                          WHERE p.member_id = s.member_id AND p.type = ?2 AND p.enabled = 0)`;
}

/**
 * Recipients by event type: a subquery of member ids, and the values it binds
 * after the actor, type and time (?4 the Group, ?5 the night). D1 refuses
 * extra bindings, so each binds only what it uses.
 */
const RECIPIENTS: Record<EventType, (groupId: number, night: string) => [sql: string, ...binds: unknown[]]> = {
  // The other Members of every Group the actor is in.
  said_yes: () => [
    "SELECT m.member_id FROM memberships mine JOIN memberships m ON m.group_id = mine.group_id WHERE mine.member_id = ?1",
  ],
  // Every Member of the Group.
  game_on: (groupId) => ["SELECT member_id FROM memberships WHERE group_id = ?4", groupId],
  // The Group's Members whose Check-in is Yes now.
  game_off: (groupId, night) => [
    `SELECT m.member_id FROM memberships m
     JOIN checkins c ON c.member_id = m.member_id AND c.game_night = ?5 AND c.availability = 'yes'
     WHERE m.group_id = ?4`,
    groupId,
    night,
  ],
};

/** What sending needs. A caller without it, such as test setup, sends nothing. */
export interface Delivery {
  push: PushSender;
  ctx: ExecutionContext;
}

/** One push's outcome, for the log line: never the endpoint or keys. */
type Outcome = "sent" | "gone" | string;

/** Turns claimed events into pushes, on D1, the injected clock and the push sender. */
export function createNotifications({ env, clock, push, ctx }: { env: Env; clock: Clock } & Partial<Delivery>) {
  const db = env.DB;

  async function sendOne(subscription: PushSubscription, payload: string): Promise<Outcome> {
    try {
      const { status } = await push!.send(subscription, payload);
      if (status === 404 || status === 410) return "gone";
      return status >= 200 && status < 300 ? "sent" : `status ${status}`;
    } catch (error) {
      // Only the error's name: a message can quote the URL it failed on.
      return error instanceof PushNotConfiguredError ? error.message : error instanceof Error ? error.name : "error";
    }
  }

  /** Sends one event's pushes and deletes the subscriptions the push service says are gone. */
  async function deliverEvent(actorId: number, night: string, event: NotificationEvent): Promise<void> {
    const groupId = "groupId" in event ? event.groupId : null;
    const [recipients, ...binds] = RECIPIENTS[event.type](groupId ?? 0, night);
    const [actor, group, subscriptions] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT username FROM members WHERE id = ?1").bind(actorId),
      db
        .prepare(
          `SELECT g.name, g.threshold,
                  (SELECT COUNT(*) FROM memberships m
                   JOIN checkins c ON c.member_id = m.member_id AND c.game_night = ?2 AND c.availability = 'yes'
                   WHERE m.group_id = g.id) AS yes
           FROM groups g WHERE g.id = ?1`,
        )
        .bind(groupId, night),
      db
        .prepare(subscriptionsSql(recipients))
        .bind(actorId, event.type, clock.now().toISOString(), ...binds),
    ]);
    const rows = subscriptions.results as { endpoint: string; p256dh: string; auth: string }[];
    const groupRow = group.results[0] as { name: string; threshold: number; yes: number } | undefined;
    if (rows.length === 0 || (groupId !== null && !groupRow)) return;

    const actorName = (actor.results[0] as { username: string } | undefined)?.username ?? "Someone";
    const payload = encodePayload(payloadFor(event, { actorName, actorId, night, group: groupRow }));
    const outcomes = await Promise.all(
      rows.map((row) => sendOne({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)),
    );

    const gone = rows.filter((_, index) => outcomes[index] === "gone");
    if (gone.length > 0) {
      await db.batch(gone.map((row) => db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(row.endpoint)));
    }
    const failed = outcomes.filter((outcome) => outcome !== "sent" && outcome !== "gone");
    if (failed.length > 0) {
      console.error(`Push ${event.type}: ${failed.length} of ${rows.length} not sent (${[...new Set(failed)].join(", ")})`);
    }
  }

  return {
    /**
     * Sends the claimed events' pushes after the response, through
     * `ctx.waitUntil`, so a slow or failing push service never delays or
     * fails the Member's request. The actor never receives their own.
     */
    send(actorId: number, night: string, events: NotificationEvent[]): void {
      if (events.length === 0 || !push || !ctx) return;
      ctx.waitUntil(
        Promise.all(
          events.map((event) =>
            deliverEvent(actorId, night, event).catch((error) =>
              console.error(`Push ${event.type}: delivery failed (${error instanceof Error ? error.name : "error"})`),
            ),
          ),
        ),
      );
    },
  };
}
