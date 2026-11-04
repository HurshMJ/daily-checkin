import {
  codePoints,
  hasInvisible,
  hasInvisibleOutsideEmoji,
  INVISIBLE_MESSAGE,
  normaliseText,
} from "~/text-rules";

import { type AvatarColour, isAvatarColour } from "./palette";

/**
 * The username as it is stored and shown: trimmed and NFC-normalised, so the
 * same name typed on two keyboards is one name.
 */
export function normaliseUsername(raw: string): string {
  return normaliseText(raw);
}

/**
 * The key of a name in the one namespace usernames and Display Names share
 * (the name_keys table): trimmed, NFC-normalised and lower-cased, so names
 * that differ only in case are one name.
 */
export function nameKey(raw: string): string {
  return normaliseText(raw).toLowerCase();
}

/** The key usernames are unique on and looked up by at login. */
export function usernameKey(raw: string): string {
  return nameKey(raw);
}

/**
 * The password as it is checked and hashed: NFC-normalised, so the same
 * password typed on two keyboards matches. Nothing is trimmed.
 */
export function normalisePassword(raw: string): string {
  return raw.normalize("NFC");
}

/** The longest password accepted, in code points of the NFC form. */
export const MAX_PASSWORD_LENGTH = 128;

/** True when a normalised password is longer than any login can have. */
export function passwordTooLong(password: string): boolean {
  return codePoints(password) > MAX_PASSWORD_LENGTH;
}

/** The longest username accepted, in code points of the normalised form. */
export const MAX_USERNAME_LENGTH = 32;

/** True when a normalised username is longer than any login can have. */
export function usernameTooLong(username: string): boolean {
  return codePoints(username) > MAX_USERNAME_LENGTH;
}

/** Returns an error message for the username field, or null when it is fine. */
export function usernameError(username: string): string | null {
  const length = codePoints(username);
  if (length < 3 || length > MAX_USERNAME_LENGTH) return `Use 3 to ${MAX_USERNAME_LENGTH} characters.`;
  if (hasInvisible(username)) return INVISIBLE_MESSAGE;
  return null;
}

/** The longest Display Name accepted, in code points of the normalised form. */
export const MAX_DISPLAY_NAME_LENGTH = 32;

/**
 * Returns an error message for a normalised, non-empty Display Name, or null
 * when it is fine. Unlike a username it may be a single character, and a
 * joined emoji such as 👨‍👩‍👧 keeps the joiners inside it.
 */
export function displayNameError(displayName: string): string | null {
  const length = codePoints(displayName);
  if (length < 1 || length > MAX_DISPLAY_NAME_LENGTH) return `Use 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.`;
  if (hasInvisibleOutsideEmoji(displayName)) return INVISIBLE_MESSAGE;
  return null;
}

/** The two names a Member has, as stored. */
export interface MemberNames {
  username: string;
  displayName: string | null;
}

/**
 * The Shown name: the name the app shows for a Member on Boards, in History,
 * on the Group page and in notifications. It is the Display Name when set,
 * otherwise the username, and is worked out when read, so a rename also
 * changes past nights.
 */
export function shownName(member: MemberNames): string {
  return member.displayName ?? member.username;
}

/** The message for a username another Member holds as a username or Display Name. */
export const USERNAME_TAKEN_MESSAGE = "That username is taken.";

/** The message for a username equal to the Member's own password. */
export const USERNAME_IS_PASSWORD_MESSAGE = "Choose a username that is not your password.";

/**
 * Returns an error message for the normalised password field, or null when it
 * is fine. Spaces count and nothing is trimmed.
 */
export function passwordError(password: string, username: string): string | null {
  const length = codePoints(password);
  if (length < 12 || length > MAX_PASSWORD_LENGTH) return "Use 12 to 128 characters.";
  if (password.toLowerCase() === username.toLowerCase()) {
    return "Choose a password that is not your username.";
  }
  return null;
}

export interface NewLoginForm {
  username: string;
  password: string;
  colour: AvatarColour;
}

export type NewLoginErrors = Partial<Record<"username" | "password" | "colour", string>>;

/**
 * Validates the create-login form. Returns the cleaned values, or the
 * field-level messages to show next to each field.
 */
export function validateNewLogin(
  form: FormData,
): { ok: true; value: NewLoginForm } | { ok: false; errors: NewLoginErrors } {
  const username = normaliseUsername(String(form.get("username") ?? ""));
  const password = normalisePassword(String(form.get("password") ?? ""));
  const colour = form.get("colour");

  const errors: NewLoginErrors = {};
  const usernameProblem = usernameError(username);
  if (usernameProblem) errors.username = usernameProblem;
  const passwordProblem = passwordError(password, username);
  if (passwordProblem) errors.password = passwordProblem;
  if (!isAvatarColour(colour)) errors.colour = "Choose a colour.";

  if (Object.keys(errors).length > 0 || !isAvatarColour(colour)) return { ok: false, errors };
  return { ok: true, value: { username, password, colour } };
}

export interface ProfileNamesForm {
  username: string;
  /** Null when the field is left empty: the Member shows their username. */
  displayName: string | null;
  colour: AvatarColour;
}

export type ProfileNamesErrors = Partial<Record<"username" | "displayName" | "colour", string>>;

/**
 * Validates the profile's name and colour form. Returns the cleaned values,
 * or the field-level messages to show next to each field.
 */
export function validateProfileNames(
  form: FormData,
): { ok: true; value: ProfileNamesForm } | { ok: false; errors: ProfileNamesErrors } {
  const username = normaliseUsername(String(form.get("username") ?? ""));
  const displayName = normaliseText(String(form.get("displayName") ?? "")) || null;
  const colour = form.get("colour");

  const errors: ProfileNamesErrors = {};
  const usernameProblem = usernameError(username);
  if (usernameProblem) errors.username = usernameProblem;
  const displayNameProblem = displayName === null ? null : displayNameError(displayName);
  if (displayNameProblem) errors.displayName = displayNameProblem;
  if (!isAvatarColour(colour)) errors.colour = "Choose a colour.";

  if (Object.keys(errors).length > 0 || !isAvatarColour(colour)) return { ok: false, errors };
  return { ok: true, value: { username, displayName, colour } };
}
