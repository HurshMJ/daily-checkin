import type { AvatarColour } from "~/auth/palette";
import { type MemberNames, shownName } from "~/auth/rules";
import { type BoardRow, compareShownNames, GAME_STATE_LABELS, sortRows, yesAnswersFrom } from "~/checkins";
import { addNights, gameNightOf, nightEnd } from "~/game-night";
import type { Clock } from "~/services";

/** The most Game Nights one Reset run freezes; a longer gap is caught up at the next runs. */
export const MAX_NIGHTS_PER_RESET = 30;

/**
 * The Game Nights a Reset due at `current` freezes, oldest first: every night
 * from the stored one up to the night before `current`, at most 30, or only
 * the night just ended when no Reset has ever run. Empty when none is due.
 */
export function nightsToFreeze(stored: string | null, current: string): string[] {
  if (stored === null) return [addNights(current, -1)];
  const nights: string[] = [];
  for (let night = stored; night < current && nights.length < MAX_NIGHTS_PER_RESET; night = addNights(night, 1)) {
    nights.push(night);
  }
  return nights;
}

/**
 * The frozen nights as a SQL row source `n` with columns `night` and `ends`
 * (the night's end as ISO-8601 UTC text), read from the JSON array bound to
 * `?1`. Binding the nights as one value keeps the statement count of a Reset
 * the same however many nights it freezes.
 */
const FROZEN_NIGHTS = `(SELECT json_extract(value, '$.night') AS night, json_extract(value, '$.ends') AS ends
   FROM json_each(?1)) n`;

/** Past nights per History page; "Show older nights" loads the next page. */
export const NIGHTS_PER_PAGE = 20;

/** How many of the Group's most recent History nights the Yes-count table covers. */
export const YES_COUNT_NIGHTS = 30;

/** A past night's state at the Reset: Game On, Game Off or Never on. */
export type FinalState = "on" | "off" | "never";

/** One past night as the History page lists it. */
export interface PastNightSummary {
  night: string;
  threshold: number;
  state: FinalState;
  yes: number;
  /** How many of the night's Members had a Check-in; 0 means nobody answered. */
  answered: number;
}

/** One current Member's line in the Yes-count table. */
export interface YesCount {
  memberId: number;
  /** The Member's Shown name: their Display Name if set, else their username. */
  shownName: string;
  username: string;
  colour: AvatarColour;
  /** Yes answers over the nights counted. */
  yes: number;
  /** The Group's last 30 History nights the Member was in the Group for. */
  nights: number;
}

/** The History page: the Yes-count table and one page of past nights, newest first. */
export interface HistoryPage {
  groupName: string;
  yesCounts: YesCount[];
  nights: PastNightSummary[];
  /** The cursor for the next page of older nights, or null when there are none. */
  older: string | null;
}

/** One row of a past night's frozen Board. */
export interface PastRow extends BoardRow {
  /** The Member has left the Group since. */
  left: boolean;
}

/** A past night's frozen Board. */
export interface PastNight extends PastNightSummary {
  groupName: string;
  rows: PastRow[];
}

/** The pill a past night shows in the list: its final state, or Nobody answered for a never-on night without Check-ins. */
export function pastPill(night: Pick<PastNightSummary, "state" | "answered">): {
  state: FinalState | "nobody";
  text: string;
} {
  if (night.state === "never" && night.answered === 0) return { state: "nobody", text: "Nobody answered" };
  return { state: night.state, text: GAME_STATE_LABELS[night.state] };
}

/** A past night's Yes count and threshold, such as "3 Yes · Game On at 3". */
export function yesLine(night: Pick<PastNightSummary, "yes" | "threshold">): string {
  return `${night.yes} Yes · Game On at ${night.threshold}`;
}

/** The line under a past night's date in the list: its Yes line, or "No Check-ins". */
export function pastCountLine(night: Pick<PastNightSummary, "yes" | "threshold" | "answered">): string {
  return night.answered === 0 ? "No Check-ins" : yesLine(night);
}

/**
 * The Yes-count table's order: by share of Yes, then by Yes count, then by
 * Shown name ignoring case. Members with no nights yet come last.
 */
export function sortYesCounts(counts: readonly YesCount[]): YesCount[] {
  return [...counts].sort(
    (a, b) =>
      Number(a.nights === 0) - Number(b.nights === 0) ||
      // Compare a.yes / a.nights with b.yes / b.nights without dividing.
      b.yes * a.nights - a.yes * b.nights ||
      b.yes - a.yes ||
      compareShownNames(a.shownName, b.shownName),
  );
}

/**
 * The Group's name, only when the Member `?1` is currently in the Group `?2`.
 * Every History read checks membership the same way, in the same batch.
 */
const MEMBER_GROUP = `SELECT g.name FROM memberships mine JOIN groups g ON g.id = mine.group_id
   WHERE mine.member_id = ?1 AND mine.group_id = ?2`;

/** A night's Yes count and how many of its Members answered, for a history_nights row `h`. */
const NIGHT_COUNTS = `(SELECT COUNT(*) FROM history_rows r WHERE r.night_id = h.id AND r.availability = 'yes') AS yes,
   (SELECT COUNT(*) FROM history_rows r WHERE r.night_id = h.id AND r.availability IS NOT NULL) AS answered`;

interface NightRow {
  game_night: string;
  threshold: number;
  final_state: FinalState;
  yes: number;
  answered: number;
}

interface PastRowRecord extends MemberNames {
  id: number;
  colour: AvatarColour;
  availability: BoardRow["availability"];
  note: string | null;
  has_left: number;
}

function summaryOf(row: NightRow): PastNightSummary {
  return {
    night: row.game_night,
    threshold: row.threshold,
    state: row.final_state,
    yes: row.yes,
    answered: row.answered,
  };
}

/** History: the Reset that freezes each Group's ended Game Night, and the History pages' reads. */
export function createHistory({ env, clock }: { env: Env; clock: Clock }) {
  const db = env.DB;

  return {
    /**
     * The Reset, run by every hourly scheduled run. When the stored Game Night
     * of the last Reset is behind the current one, it freezes each ended
     * night (see `nightsToFreeze`) for every Group created before the night
     * ended: one History night with the Group's threshold and final state,
     * and one row per Member who joined before the night ended, with their
     * Check-in in that Group or none. All writes go in one D1 batch, which is one
     * transaction. Rows already frozen are kept (ON CONFLICT DO NOTHING) and
     * the stored night only moves forward, so a repeat or overlapping run
     * changes nothing. Check-ins are kept: Boards read only the current Game
     * Night, so they start empty. Returns the nights frozen.
     */
    async reset(): Promise<string[]> {
      const current = gameNightOf(clock.now());
      const state = await db
        .prepare("SELECT last_reset_game_night AS night FROM scheduler_state WHERE id = 1")
        .first<{ night: string | null }>();
      const nights = nightsToFreeze(state?.night ?? null, current);
      if (nights.length === 0) return [];

      const frozen = JSON.stringify(nights.map((night) => ({ night, ends: nightEnd(night).toISOString() })));
      const started = addNights(nights[nights.length - 1], 1);
      await db.batch([
        // Final state: Game On when the night's Members reached the threshold,
        // else Game Off when the Group was Game On during the night, else Never on.
        // This CASE restates pillFor's on/off rule (app/checkins.ts) in SQL and
        // must change with it.
        // SQLite needs the WHERE before ON CONFLICT when an INSERT's SELECT has a join.
        db
          .prepare(
            `INSERT INTO history_nights (group_id, game_night, threshold, final_state)
             SELECT g.id, n.night, g.threshold,
               CASE
                 WHEN (SELECT COUNT(*) ${yesAnswersFrom("g.id", "n.night", "m.joined_at < n.ends")}) >= g.threshold THEN 'on'
                 WHEN EXISTS (SELECT 1 FROM group_night_state s
                              WHERE s.group_id = g.id AND s.game_night = n.night AND s.was_on = 1) THEN 'off'
                 ELSE 'never'
               END
             FROM ${FROZEN_NIGHTS}
             JOIN groups g ON g.created_at < n.ends
             WHERE true
             ON CONFLICT (group_id, game_night) DO NOTHING`,
          )
          .bind(frozen),
        db
          .prepare(
            `INSERT INTO history_rows (night_id, member_id, availability, note)
             SELECT h.id, m.member_id, c.availability, c.note
             FROM ${FROZEN_NIGHTS}
             JOIN groups g ON g.created_at < n.ends
             JOIN history_nights h ON h.group_id = g.id AND h.game_night = n.night
             JOIN memberships m ON m.group_id = g.id AND m.joined_at < n.ends
             LEFT JOIN group_checkins c ON c.group_id = g.id AND c.member_id = m.member_id AND c.game_night = n.night
             WHERE true
             ON CONFLICT (night_id, member_id) DO NOTHING`,
          )
          .bind(frozen),
        db
          .prepare(
            `INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, ?1)
             ON CONFLICT (id) DO UPDATE SET last_reset_game_night = excluded.last_reset_game_night
             WHERE scheduler_state.last_reset_game_night IS NULL
                OR scheduler_state.last_reset_game_night < excluded.last_reset_game_night`,
          )
          .bind(started),
      ]);
      return nights;
    },

    /**
     * The History page for a current Member of the Group: the Yes-count
     * table and up to 20 past nights, newest first, older than `before`
     * when it is given. Null for anyone not in the Group now. One D1 batch.
     */
    async historyPage(memberId: number, groupId: number, before: string | null): Promise<HistoryPage | null> {
      const [group, counts, nights] = await db.batch<Record<string, unknown>>([
        db.prepare(MEMBER_GROUP).bind(memberId, groupId),
        // Each current Member's rows over the Group's last 30 History nights.
        db
          .prepare(
            `WITH recent AS (
               SELECT id FROM history_nights WHERE group_id = ?2 ORDER BY game_night DESC LIMIT ${YES_COUNT_NIGHTS}
             )
             SELECT p.id, p.username, p.display_name AS displayName, p.colour,
               COUNT(r.night_id) AS nights,
               COUNT(CASE WHEN r.availability = 'yes' THEN 1 END) AS yes
             FROM memberships mine
             JOIN memberships m ON m.group_id = mine.group_id
             JOIN members p ON p.id = m.member_id
             LEFT JOIN history_rows r ON r.member_id = p.id AND r.night_id IN (SELECT id FROM recent)
             WHERE mine.member_id = ?1 AND mine.group_id = ?2
             GROUP BY p.id`,
          )
          .bind(memberId, groupId),
        // One more than a page, to tell whether older nights exist.
        db
          .prepare(
            `SELECT h.game_night, h.threshold, h.final_state, ${NIGHT_COUNTS}
             FROM memberships mine JOIN history_nights h ON h.group_id = mine.group_id
             WHERE mine.member_id = ?1 AND mine.group_id = ?2 AND (?3 IS NULL OR h.game_night < ?3)
             ORDER BY h.game_night DESC
             LIMIT ${NIGHTS_PER_PAGE + 1}`,
          )
          .bind(memberId, groupId, before),
      ]);
      const name = (group.results[0] as { name: string } | undefined)?.name;
      if (name === undefined) return null;

      const page = (nights.results as unknown as NightRow[]).map(summaryOf);
      const older = page.length > NIGHTS_PER_PAGE ? page[NIGHTS_PER_PAGE - 1].night : null;
      return {
        groupName: name,
        yesCounts: sortYesCounts(
          (counts.results as unknown as (MemberNames & { id: number; colour: AvatarColour; nights: number; yes: number })[]).map(
            (row) => ({
              memberId: row.id,
              shownName: shownName(row),
              username: row.username,
              colour: row.colour,
              yes: row.yes,
              nights: row.nights,
            }),
          ),
        ),
        nights: page.slice(0, NIGHTS_PER_PAGE),
        older,
      };
    },

    /**
     * One past night's frozen Board for a current Member of the Group, rows
     * in Board order with names as they are now. A Member who has left since
     * keeps their row, marked `left`. Null for anyone not in the Group now,
     * and for a night the Group has no History for. One D1 batch.
     */
    async pastNight(memberId: number, groupId: number, night: string): Promise<PastNight | null> {
      const [header, rows] = await db.batch<Record<string, unknown>>([
        db
          .prepare(
            `SELECT g.name, h.game_night, h.threshold, h.final_state, ${NIGHT_COUNTS}
             FROM memberships mine
             JOIN groups g ON g.id = mine.group_id
             JOIN history_nights h ON h.group_id = g.id AND h.game_night = ?3
             WHERE mine.member_id = ?1 AND mine.group_id = ?2`,
          )
          .bind(memberId, groupId, night),
        db
          .prepare(
            `SELECT p.id, p.username, p.display_name AS displayName, p.colour, r.availability, r.note,
               cur.member_id IS NULL AS has_left
             FROM memberships mine
             JOIN history_nights h ON h.group_id = mine.group_id AND h.game_night = ?3
             JOIN history_rows r ON r.night_id = h.id
             JOIN members p ON p.id = r.member_id
             LEFT JOIN memberships cur ON cur.group_id = h.group_id AND cur.member_id = p.id
             WHERE mine.member_id = ?1 AND mine.group_id = ?2`,
          )
          .bind(memberId, groupId, night),
      ]);
      const found = header.results[0] as unknown as (NightRow & { name: string }) | undefined;
      if (!found) return null;

      return {
        ...summaryOf(found),
        groupName: found.name,
        rows: sortRows(
          (rows.results as unknown as PastRowRecord[]).map(
            (row): PastRow => ({
              memberId: row.id,
              shownName: shownName(row),
              username: row.username,
              colour: row.colour,
              availability: row.availability,
              note: row.note,
              left: row.has_left === 1,
            }),
          ),
        ),
      };
    },
  };
}
