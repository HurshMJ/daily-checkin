import type { AvatarColour } from "~/auth/palette";
import { shownName } from "~/auth/rules";
import { gameNightOf } from "~/game-night";
import { allClaims, batchWithClaims, type Claims, createNotifications, type Delivery, saidYesClaims } from "~/notifications";
import type { Clock } from "~/services";
import { codePoints, hasInvisible, INVISIBLE_MESSAGE, normaliseText } from "~/text-rules";

export const AVAILABILITIES = ["yes", "maybe", "no"] as const;

/** A Member's answer for tonight. "No answer yet" is the absence of a Check-in. */
export type Availability = (typeof AVAILABILITIES)[number];

export function isAvailability(value: unknown): value is Availability {
  return typeof value === "string" && (AVAILABILITIES as readonly string[]).includes(value);
}

/** How each Availability reads on a tile and a Board row. */
export const AVAILABILITY_LABELS: Record<Availability, string> = { yes: "Yes", maybe: "Maybe", no: "No" };

/** The longest Note, in code points of the NFC form. */
export const MAX_NOTE_LENGTH = 140;

/** The Note as it is stored: trimmed and NFC-normalised, or null for no Note. */
export function normaliseNote(raw: string): string | null {
  const note = normaliseText(raw);
  return note === "" ? null : note;
}

/** Returns an error message for a normalised Note, or null when it is fine. */
export function noteError(note: string | null): string | null {
  if (note === null) return null;
  if (codePoints(note) > MAX_NOTE_LENGTH) return `Use at most ${MAX_NOTE_LENGTH} characters.`;
  if (hasInvisible(note)) return INVISIBLE_MESSAGE;
  return null;
}

export type PillState = "on" | "off" | "needs";

/**
 * The Board's pill. Game On at or above the threshold; Game Off when the Group
 * was Game On earlier tonight and has dropped below; otherwise how many more
 * Yes answers it needs.
 */
export function pillFor({ yes, threshold, wasOn }: { yes: number; threshold: number; wasOn: boolean }): {
  state: PillState;
  text: string;
} {
  if (yes >= threshold) return { state: "on", text: "Game On" };
  if (wasOn) return { state: "off", text: "Game Off" };
  return { state: "needs", text: `Needs ${threshold - yes} more Yes` };
}

/** One Member's row on a Board. */
export interface BoardRow {
  memberId: number;
  /** The Member's Shown name: their Display Name if set, else their username. */
  shownName: string;
  username: string;
  colour: AvatarColour;
  availability: Availability | null;
  note: string | null;
}

const ROW_ORDER: Record<Availability | "none", number> = { yes: 0, maybe: 1, no: 2, none: 3 };

/**
 * Orders two Shown names ignoring case, then as typed, so the order is stable
 * between visits. Boards and History sort Members with it.
 */
export function compareShownNames(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
}

/**
 * Board rows in order: Yes, Maybe, No, then no answer yet. Within each, by
 * Shown name ignoring case, so the order is stable between visits.
 */
export function sortRows<Row extends Pick<BoardRow, "availability" | "shownName">>(rows: readonly Row[]): Row[] {
  return [...rows].sort(
    (a, b) =>
      ROW_ORDER[a.availability ?? "none"] - ROW_ORDER[b.availability ?? "none"] ||
      compareShownNames(a.shownName, b.shownName),
  );
}

/** The line under "Tonight" saying how many Boards one answer reaches. */
export function boardReachLine(boards: number): string {
  return boards === 1 ? "Your answer shows on your Board" : `Your answer shows on all ${boards} of your Boards`;
}

/** One Group's Board for tonight. */
export interface Board {
  groupId: number;
  name: string;
  threshold: number;
  yes: number;
  pill: { state: PillState; text: string };
  rows: BoardRow[];
}

/** What the Tonight screen shows a Member. */
export interface Tonight {
  gameNight: string;
  /** The Member's own Check-in, or null before they answer. */
  own: { availability: Availability; note: string | null } | null;
  boards: Board[];
}

export type SetNoteResult = { ok: true } | { ok: false; error: string };

export const ANSWER_FIRST_MESSAGE = "Answer Yes, Maybe or No before adding a Note.";

/** The Groups a change touches, as a `FROM ... WHERE` clause that binds `?1` and aliases each Group `g`. */
type GroupSource = string;

/** Every Group the Member `?1` is in: for a Check-in change or the Member joining. */
const MEMBER_GROUPS: GroupSource = "FROM memberships mine JOIN groups g ON g.id = mine.group_id WHERE mine.member_id = ?1";

/** The one Group `?1`: for a change to its threshold or Members. */
const ONE_GROUP: GroupSource = "FROM groups g WHERE g.id = ?1";

/** The Group `g`'s count of Yes answers from its current Members on the Game Night `?2`. */
const YES_COUNT = `(SELECT COUNT(*) FROM memberships m
            JOIN checkins c ON c.member_id = m.member_id AND c.game_night = ?2 AND c.availability = 'yes'
            WHERE m.group_id = g.id)`;

/**
 * The one Game On rule: marks each Group `g` that the `source` clause selects
 * as Game On on the Game Night `?2` when its current Members have at least its
 * threshold of Yes answers. Nothing ever clears the mark within the night,
 * which is how Game Off is told apart.
 */
function gameOnSql(source: GroupSource): string {
  return `INSERT INTO group_night_state (group_id, game_night, was_on)
     SELECT g.id, ?2, 1
     ${source}
       AND ${YES_COUNT} >= g.threshold
     ON CONFLICT (group_id, game_night) DO UPDATE SET was_on = 1`;
}

/**
 * The first crossing up and the first crossing down, for the Groups `source`
 * selects, as claims that run right after the Game On statement in the same
 * batch. Game On is claimed once a Group is marked on; Game Off once a Group
 * that was on has fewer Yes answers than its threshold. Each flag is set at
 * most once per Group per night, so later crossings are silent.
 */
function gameClaims(db: D1Database, source: GroupSource, id: number, night: string): Claims {
  const touched = `group_id IN (SELECT g.id ${source}`;
  return {
    statements: [
      db
        .prepare(
          `UPDATE group_night_state SET game_on_sent = 1
           WHERE game_night = ?2 AND was_on = 1 AND game_on_sent = 0 AND ${touched})
           RETURNING group_id`,
        )
        .bind(id, night),
      db
        .prepare(
          `UPDATE group_night_state SET game_off_sent = 1
           WHERE game_night = ?2 AND was_on = 1 AND game_off_sent = 0 AND ${touched} AND ${YES_COUNT} < g.threshold)
           RETURNING group_id`,
        )
        .bind(id, night),
    ],
    events: ([on, off]) => [
      ...(on.results as { group_id: number }[]).map((row) => ({ type: "game_on" as const, groupId: row.group_id })),
      ...(off.results as { group_id: number }[]).map((row) => ({ type: "game_off" as const, groupId: row.group_id })),
    ],
  };
}

/**
 * The Game On statement for every Group of the Member. Run it in the same D1
 * batch as any change that can raise those Groups' Yes counts: a Check-in
 * change, or the Member joining a Group. Follow it with `memberGameClaims`.
 */
export function gameOnStatement(db: D1Database, memberId: number, night: string): D1PreparedStatement {
  return db.prepare(gameOnSql(MEMBER_GROUPS)).bind(memberId, night);
}

/** The Game On and Game Off claims for every Group of the Member, to follow `gameOnStatement`. */
export function memberGameClaims(db: D1Database, memberId: number, night: string): Claims {
  return gameClaims(db, MEMBER_GROUPS, memberId, night);
}

/**
 * The Game On statement for one Group. Run it in the same D1 batch as any
 * change to the Group's threshold or Members. Follow it with `groupGameClaims`.
 */
export function groupGameOnStatement(db: D1Database, groupId: number, night: string): D1PreparedStatement {
  return db.prepare(gameOnSql(ONE_GROUP)).bind(groupId, night);
}

/** The Game On and Game Off claims for one Group, to follow `groupGameOnStatement`. */
export function groupGameClaims(db: D1Database, groupId: number, night: string): Claims {
  return gameClaims(db, ONE_GROUP, groupId, night);
}

/**
 * Check-ins and tonight's Boards, on D1 and the injected clock. With the push
 * sender and execution context, changes also send the pushes they cause.
 */
export function createCheckins({ env, clock, ...delivery }: { env: Env; clock: Clock } & Partial<Delivery>) {
  const db = env.DB;
  const notifications = createNotifications({ env, clock, ...delivery });

  return {
    /**
     * Sets the Member's Availability for tonight, creating the Check-in or
     * changing it and keeping its Note. In the same D1 batch, which is one
     * transaction, every Group of the Member that now has at least its
     * threshold of Yes answers is marked Game On for tonight. Nothing ever
     * clears that mark within the night, which is how Game Off is told apart.
     * The same batch claims "someone said Yes", Game On and Game Off, which
     * are then sent to everyone but the Member.
     */
    async setAvailability(memberId: number, availability: Availability): Promise<void> {
      const now = clock.now();
      const night = gameNightOf(now);
      const claims = allClaims(saidYesClaims(db, memberId, night), memberGameClaims(db, memberId, night));
      const { events } = await batchWithClaims(db, [
        db
          .prepare(
            `INSERT INTO checkins (member_id, game_night, availability, note, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4)
             ON CONFLICT (member_id, game_night)
             DO UPDATE SET availability = excluded.availability, updated_at = excluded.updated_at`,
          )
          .bind(memberId, night, availability, now.toISOString()),
        gameOnStatement(db, memberId, night),
      ], claims);
      notifications.send(memberId, night, events);
    },

    /**
     * Sets or removes the Note on tonight's Check-in. A Member with no
     * Check-in tonight cannot add a Note: the Note never stands in for an
     * Availability, and an empty Note never clears one.
     */
    async setNote(memberId: number, raw: string): Promise<SetNoteResult> {
      const note = normaliseNote(raw);
      const error = noteError(note);
      if (error) return { ok: false, error };

      const now = clock.now();
      const result = await db
        .prepare("UPDATE checkins SET note = ?1, updated_at = ?2 WHERE member_id = ?3 AND game_night = ?4")
        .bind(note, now.toISOString(), memberId, gameNightOf(now))
        .run();
      if (result.meta.changes === 0) return { ok: false, error: ANSWER_FIRST_MESSAGE };
      return { ok: true };
    },

    /** The Member's own Check-in and every Board they are on, for tonight. */
    async tonightFor(memberId: number): Promise<Tonight> {
      const night = gameNightOf(clock.now());
      const [own, groups, rows] = await db.batch<Record<string, unknown>>([
        db
          .prepare("SELECT availability, note FROM checkins WHERE member_id = ?1 AND game_night = ?2")
          .bind(memberId, night),
        db
          .prepare(
            `SELECT g.id, g.name, g.threshold, COALESCE(s.was_on, 0) AS was_on
             FROM memberships mine JOIN groups g ON g.id = mine.group_id
             LEFT JOIN group_night_state s ON s.group_id = g.id AND s.game_night = ?2
             WHERE mine.member_id = ?1
             ORDER BY mine.joined_at, g.id`,
          )
          .bind(memberId, night),
        db
          .prepare(
            `SELECT m.group_id, p.id, p.username, p.display_name AS displayName, p.colour, c.availability, c.note
             FROM memberships mine
             JOIN memberships m ON m.group_id = mine.group_id
             JOIN members p ON p.id = m.member_id
             LEFT JOIN checkins c ON c.member_id = p.id AND c.game_night = ?2
             WHERE mine.member_id = ?1`,
          )
          .bind(memberId, night),
      ]);

      const ownRow = own.results[0] as { availability: Availability; note: string | null } | undefined;
      const memberRows = rows.results as {
        group_id: number;
        id: number;
        username: string;
        displayName: string | null;
        colour: AvatarColour;
        availability: Availability | null;
        note: string | null;
      }[];

      const boards = (groups.results as { id: number; name: string; threshold: number; was_on: number }[]).map(
        (group): Board => {
          const boardRows = memberRows
            .filter((row) => row.group_id === group.id)
            .map((row): BoardRow => ({
              memberId: row.id,
              shownName: shownName(row),
              username: row.username,
              colour: row.colour,
              availability: row.availability,
              note: row.note,
            }));
          const yes = boardRows.filter((row) => row.availability === "yes").length;
          return {
            groupId: group.id,
            name: group.name,
            threshold: group.threshold,
            yes,
            pill: pillFor({ yes, threshold: group.threshold, wasOn: group.was_on === 1 }),
            rows: sortRows(boardRows),
          };
        },
      );

      return {
        gameNight: night,
        own: ownRow ? { availability: ownRow.availability, note: ownRow.note } : null,
        boards,
      };
    },
  };
}
