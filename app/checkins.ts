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
 * How each outcome of the Game On rule reads on a pill: tonight's Board uses
 * on and off, a past night's pill and banner use all three.
 */
export const GAME_STATE_LABELS = { on: "Game On", off: "Game Off", never: "Never on" } as const;

/**
 * The Board's pill. Game On at or above the threshold; Game Off when the Group
 * was Game On earlier tonight and has dropped below; otherwise how many more
 * Yes answers it needs.
 */
export function pillFor({ yes, threshold, wasOn }: { yes: number; threshold: number; wasOn: boolean }): {
  state: PillState;
  text: string;
} {
  if (yes >= threshold) return { state: "on", text: GAME_STATE_LABELS.on };
  if (wasOn) return { state: "off", text: GAME_STATE_LABELS.off };
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

/** A Member's Check-in in one Group for tonight. */
export interface OwnCheckin {
  availability: Availability;
  note: string | null;
}

/** One Group's Board for tonight. */
export interface Board {
  groupId: number;
  name: string;
  threshold: number;
  yes: number;
  pill: { state: PillState; text: string };
  rows: BoardRow[];
  /** The viewer's own Check-in in this Group, or null before they answer here. */
  own: OwnCheckin | null;
}

/** What the Tonight screen shows a Member. */
export interface Tonight {
  gameNight: string;
  boards: Board[];
}

/** A Check-in change that wrote nothing because the Member is not in the Group now. */
export type NotMember = { ok: false; notMember: true };

export type SetAvailabilityResult = { ok: true } | NotMember;

export type SetNoteResult = { ok: true } | { ok: false; notMember: false; error: string } | NotMember;

export const ANSWER_FIRST_MESSAGE = "Answer Yes, Maybe or No before adding a Note.";

/** The Groups a change touches, as a `FROM ... WHERE` clause that binds `?1` and aliases each Group `g`. */
type GroupSource = string;

/** Every Group the Member `?1` is in: for the Member joining a Group. */
const MEMBER_GROUPS: GroupSource = "FROM memberships mine JOIN groups g ON g.id = mine.group_id WHERE mine.member_id = ?1";

/** The one Group `?1`: for a Check-in in it or a change to its threshold or Members. */
const ONE_GROUP: GroupSource = "FROM groups g WHERE g.id = ?1";

/**
 * The one Yes rule: a Group's Yes answers on a Game Night are the Check-ins in
 * it with Availability yes from its current Members. Returns the `FROM ...
 * WHERE` clause over those rows, with memberships aliased `m` and
 * group_checkins aliased `c`, for the SQL expressions `group` (the Group id)
 * and `night` (the Game Night). By default it counts all of the Group's current
 * Members; `memberFilter` narrows them further (History passes
 * `m.joined_at < n.ends`). Every argument is a fixed SQL expression written in
 * code, never request data.
 */
export function yesAnswersFrom(group: string, night: string, memberFilter?: string): string {
  return `FROM memberships m
     JOIN group_checkins c ON c.group_id = m.group_id AND c.member_id = m.member_id
       AND c.game_night = ${night} AND c.availability = 'yes'
     WHERE m.group_id = ${group}${memberFilter ? ` AND ${memberFilter}` : ""}`;
}

/** The Group `g`'s count of Yes answers in it from its current Members on the Game Night `?2`. */
export const YES_COUNT = `(SELECT COUNT(*) ${yesAnswersFrom("g.id", "?2")})`;

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
 * batch as the Member joining a Group, which can raise that Group's Yes count
 * when a Member rejoins on a night they answered Yes in it. Follow it with
 * `memberGameClaims`.
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
 * Check-in in the Group or change to its threshold or Members. Follow it with
 * `groupGameClaims`.
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

  /** Whether the Member `?2` is in the Group `?1` now, as a SQL condition. */
  const IS_MEMBER = "EXISTS (SELECT 1 FROM memberships WHERE group_id = ?1 AND member_id = ?2)";

  return {
    /**
     * Sets the Member's Availability in one Group for tonight, creating the
     * Check-in or changing it and keeping its Note. The write is gated on the
     * Member being in the Group now, so a removal racing the post writes
     * nothing. In the same D1 batch, which is one transaction, the Group is
     * marked Game On for tonight when it now has at least its threshold of Yes
     * answers; nothing ever clears that mark within the night, which is how
     * Game Off is told apart. The same batch claims "someone said Yes" for
     * this Group, Game On and Game Off, which are then sent to everyone but
     * the Member.
     */
    async setAvailability(memberId: number, groupId: number, availability: Availability): Promise<SetAvailabilityResult> {
      const now = clock.now();
      const night = gameNightOf(now);
      const claims = allClaims(saidYesClaims(db, groupId, memberId, night), groupGameClaims(db, groupId, night));
      const { results, events } = await batchWithClaims(db, [
        db
          .prepare(
            `INSERT INTO group_checkins (group_id, member_id, game_night, availability, note, updated_at)
             SELECT ?1, ?2, ?3, ?4, NULL, ?5 WHERE ${IS_MEMBER}
             ON CONFLICT (group_id, member_id, game_night)
             DO UPDATE SET availability = excluded.availability, updated_at = excluded.updated_at`,
          )
          .bind(groupId, memberId, night, availability, now.toISOString()),
        groupGameOnStatement(db, groupId, night),
      ], claims);
      notifications.send(memberId, night, events);
      return results[0].meta.changes > 0 ? { ok: true } : { ok: false, notMember: true };
    },

    /**
     * Sets or removes the Note on the Member's Check-in in one Group tonight.
     * A Member with no Check-in in the Group tonight cannot add a Note there:
     * the Note never stands in for an Availability, and an empty Note never
     * clears one. Like the Availability, the write is gated on the Member
     * being in the Group now.
     */
    async setNote(memberId: number, groupId: number, raw: string): Promise<SetNoteResult> {
      const note = normaliseNote(raw);
      const error = noteError(note);
      if (error) return { ok: false, notMember: false, error };

      const now = clock.now();
      const [result, member] = await db.batch<{ member: number }>([
        db
          .prepare(
            `UPDATE group_checkins SET note = ?3, updated_at = ?4
             WHERE group_id = ?1 AND member_id = ?2 AND game_night = ?5 AND ${IS_MEMBER}`,
          )
          .bind(groupId, memberId, note, now.toISOString(), gameNightOf(now)),
        db.prepare(`SELECT ${IS_MEMBER} AS member`).bind(groupId, memberId),
      ]);
      if (result.meta.changes > 0) return { ok: true };
      if (member.results[0]?.member !== 1) return { ok: false, notMember: true };
      return { ok: false, notMember: false, error: ANSWER_FIRST_MESSAGE };
    },

    /** Every Board the Member is on for tonight, each with the Member's own Check-in in it. */
    async tonightFor(memberId: number): Promise<Tonight> {
      const night = gameNightOf(clock.now());
      const [groups, rows] = await db.batch<Record<string, unknown>>([
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
             LEFT JOIN group_checkins c ON c.group_id = m.group_id AND c.member_id = p.id AND c.game_night = ?2
             WHERE mine.member_id = ?1`,
          )
          .bind(memberId, night),
      ]);

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
          const own = boardRows.find((row) => row.memberId === memberId);
          return {
            groupId: group.id,
            name: group.name,
            threshold: group.threshold,
            yes,
            pill: pillFor({ yes, threshold: group.threshold, wasOn: group.was_on === 1 }),
            rows: sortRows(boardRows),
            own: own?.availability ? { availability: own.availability, note: own.note } : null,
          };
        },
      );

      return { gameNight: night, boards };
    },
  };
}
