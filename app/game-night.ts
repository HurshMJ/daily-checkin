/**
 * A Game Night runs from 06:00 UTC+4 to just before 06:00 UTC+4 the next day,
 * and is named by the UTC+4 date it starts on. The offset is fixed: UTC+4 has
 * no daylight saving time, so no time zone database is needed.
 */
const UTC_PLUS_4_MS = 4 * 60 * 60 * 1000;
const NIGHT_STARTS_AT_MS = 6 * 60 * 60 * 1000;

/**
 * The Game Night an instant belongs to, as `YYYY-MM-DD`: the UTC+4 date of the
 * most recent 06:00 UTC+4 at or before it. 06:00 UTC+4 itself starts the new
 * night. Every caller passes `clock.now()`, so tests can move time.
 */
export function gameNightOf(instant: Date): string {
  return new Date(instant.getTime() + UTC_PLUS_4_MS - NIGHT_STARTS_AT_MS).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * An instant as the day, month and 24-hour time in UTC+4, the Game Night
 * zone, such as "3 Nov, 16:05". The fixed offset needs no time zone data.
 */
export function zoneDayTime(instant: Date): string {
  const local = new Date(instant.getTime() + UTC_PLUS_4_MS);
  const hours = String(local.getUTCHours()).padStart(2, "0");
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}, ${hours}:${minutes}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC instant of midnight at the start of a `YYYY-MM-DD` date. */
function dateStart(night: string): number {
  return Date.parse(`${night}T00:00:00.000Z`);
}

/** The Game Night `days` after `night` (or before, when negative), as `YYYY-MM-DD`. */
export function addNights(night: string, days: number): string {
  return new Date(dateStart(night) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant a Game Night ends: 06:00 UTC+4 on the next day, which is the
 * Reset that freezes it. Compare it as `toISOString()` text with the stored
 * `created_at` and `joined_at` times, which have the same format.
 */
export function nightEnd(night: string): Date {
  return new Date(dateStart(night) + DAY_MS + NIGHT_STARTS_AT_MS - UTC_PLUS_4_MS);
}

/** Whether a string names a real Game Night: a valid `YYYY-MM-DD` date. */
export function isGameNight(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const start = dateStart(value);
  return !Number.isNaN(start) && new Date(start).toISOString().slice(0, 10) === value;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A Game Night as History shows it: the weekday, day and month, such as "Sun 1 Nov". */
export function nightLabel(night: string): string {
  const start = new Date(dateStart(night));
  return `${WEEKDAYS[start.getUTCDay()]} ${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]}`;
}
