import type { AvatarColour } from "~/auth/palette";
import { gameNightOf } from "~/game-night";
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
  username: string;
  colour: AvatarColour;
  availability: Availability | null;
  note: string | null;
}

const ROW_ORDER: Record<Availability | "none", number> = { yes: 0, maybe: 1, no: 2, none: 3 };

/**
 * Board rows in order: Yes, Maybe, No, then no answer yet. Within each, by
 * username ignoring case, so the order is stable between visits.
 */
export function sortRows<Row extends Pick<BoardRow, "availability" | "username">>(rows: readonly Row[]): Row[] {
  return [...rows].sort(
    (a, b) =>
      ROW_ORDER[a.availability ?? "none"] - ROW_ORDER[b.availability ?? "none"] ||
      a.username.toLowerCase().localeCompare(b.username.toLowerCase()) ||
      a.username.localeCompare(b.username),
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

/**
 * The one Game On statement: marks every Group of the Member that has at
 * least its threshold of Yes answers on the Game Night as Game On. Run it in
 * the same D1 batch as any change that can raise a Group's Yes count: a
 * Check-in change, or the Member joining a Group. Nothing ever clears the
 * mark within the night, which is how Game Off is told apart.
 */
export function gameOnStatement(db: D1Database, memberId: number, night: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO group_night_state (group_id, game_night, was_on)
       SELECT g.id, ?2, 1
       FROM memberships mine JOIN groups g ON g.id = mine.group_id
       WHERE mine.member_id = ?1
         AND (SELECT COUNT(*) FROM memberships m
              JOIN checkins c ON c.member_id = m.member_id AND c.game_night = ?2 AND c.availability = 'yes'
              WHERE m.group_id = g.id) >= g.threshold
       ON CONFLICT (group_id, game_night) DO UPDATE SET was_on = 1`,
    )
    .bind(memberId, night);
}

/** Check-ins and tonight's Boards, on D1 and the injected clock. */
export function createCheckins({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;

  return {
    /**
     * Sets the Member's Availability for tonight, creating the Check-in or
     * changing it and keeping its Note. In the same D1 batch, which is one
     * transaction, every Group of the Member that now has at least its
     * threshold of Yes answers is marked Game On for tonight. Nothing ever
     * clears that mark within the night, which is how Game Off is told apart.
     */
    async setAvailability(memberId: number, availability: Availability): Promise<void> {
      const now = clock.now();
      const night = gameNightOf(now);
      await db.batch([
        db
          .prepare(
            `INSERT INTO checkins (member_id, game_night, availability, note, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4)
             ON CONFLICT (member_id, game_night)
             DO UPDATE SET availability = excluded.availability, updated_at = excluded.updated_at`,
          )
          .bind(memberId, night, availability, now.toISOString()),
        gameOnStatement(db, memberId, night),
      ]);
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
            `SELECT m.group_id, p.id, p.username, p.colour, c.availability, c.note
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
