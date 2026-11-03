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
     * Check-in or none. All writes go in one D1 batch, which is one
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
        // SQLite needs the WHERE before ON CONFLICT when an INSERT's SELECT has a join.
        db
          .prepare(
            `INSERT INTO history_nights (group_id, game_night, threshold, final_state)
             SELECT g.id, n.night, g.threshold,
               CASE
                 WHEN (SELECT COUNT(*) FROM memberships m
                       JOIN checkins c ON c.member_id = m.member_id AND c.game_night = n.night AND c.availability = 'yes'
                       WHERE m.group_id = g.id AND m.joined_at < n.ends) >= g.threshold THEN 'on'
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
             LEFT JOIN checkins c ON c.member_id = m.member_id AND c.game_night = n.night
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
  };
}
