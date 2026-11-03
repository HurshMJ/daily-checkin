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
