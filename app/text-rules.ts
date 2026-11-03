/**
 * The one counting rule for names and short text a Member types: usernames,
 * Group names and Notes are trimmed, NFC-normalised and counted in code
 * points, and names refuse invisible characters.
 */

/** Trims and NFC-normalises typed text, so the same text typed on two keyboards is one text. */
export function normaliseText(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** The length of a text in code points, so an emoji such as 🎲 counts once. */
export function codePoints(text: string): number {
  return [...text].length;
}

// Control characters (Cc, such as tab and newline) and invisible format
// characters (Cf, such as zero-width space) would let two names look alike.
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/** True when the text holds a control or invisible format character. */
export function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text);
}

/** The error shown for a name or Note holding a control or invisible character. */
export const INVISIBLE_MESSAGE = "Remove tabs, line breaks and invisible characters.";
