import { type AvatarColour, isAvatarColour } from "./palette";

/**
 * The username as it is stored and shown: trimmed and NFC-normalised, so the
 * same name typed on two keyboards is one name.
 */
export function normaliseUsername(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** The key usernames are unique on and looked up by at login. */
export function usernameKey(raw: string): string {
  return normaliseUsername(raw).toLowerCase();
}

function codePoints(text: string): number {
  return [...text].length;
}

// Control characters (Cc, such as tab and newline) and invisible format
// characters (Cf, such as zero-width space) would let two names look alike.
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/** Returns an error message for the username field, or null when it is fine. */
export function usernameError(username: string): string | null {
  const length = codePoints(username);
  if (length < 3 || length > 32) return "Use 3 to 32 characters.";
  if (INVISIBLE.test(username)) return "Remove tabs, line breaks and invisible characters.";
  return null;
}

/**
 * Returns an error message for the password field, or null when it is fine.
 * The password is taken as typed: spaces count and nothing is trimmed.
 */
export function passwordError(password: string, username: string): string | null {
  const length = codePoints(password);
  if (length < 12 || length > 128) return "Use 12 to 128 characters.";
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
  const password = String(form.get("password") ?? "");
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
