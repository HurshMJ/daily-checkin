/**
 * The one counting rule for names and short text a Member types: usernames,
 * Display Names, Group names and Notes are trimmed, NFC-normalised and counted
 * in code points, and names refuse invisible characters.
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

// Inside an emoji sequence two format characters are part of the emoji, not
// hidden text: the zero-width joiner (U+200D) that joins 👨 and 👩 into 👨‍👩‍👧,
// and the tag characters (U+E0020 to U+E007F) that spell a subdivision flag
// such as 🏴󠁧󠁢󠁳󠁣󠁴󠁿. A joiner counts as inside a sequence when an emoji, optionally
// followed by its skin tone or U+FE0F presentation selector, comes before it
// and an emoji comes after it; tags count when they follow the black flag
// U+1F3F4 and end with the cancel tag U+E007F.
const EMOJI_JOINER =
  /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\u{FE0F}]?)\u{200D}(?=\p{Extended_Pictographic})/gu;
const EMOJI_TAGS = /(?<=\u{1F3F4})[\u{E0020}-\u{E007E}]+\u{E007F}/gu;

/**
 * True when the text holds a control or invisible format character outside
 * an emoji sequence. Display Names use this rule, so joined emoji such as 👨‍👩‍👧
 * and 🏳️‍🌈 are accepted while a joiner between letters is refused.
 */
export function hasInvisibleOutsideEmoji(text: string): boolean {
  return hasInvisible(text.replace(EMOJI_JOINER, "").replace(EMOJI_TAGS, ""));
}

/** The error shown for a name or Note holding a control or invisible character. */
export const INVISIBLE_MESSAGE = "Remove tabs, line breaks and invisible characters.";
