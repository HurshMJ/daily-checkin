/**
 * Token and password primitives on Web Crypto. Nothing here touches D1.
 */

/** The most PBKDF2 iterations the Workers runtime accepts. */
export const MAX_PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new random token: 32 bytes, base64url, for a cookie or a link. */
export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What D1 stores for a token: its SHA-256 as 64 lower-case hex digits. */
export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

/**
 * Reads the current iteration count from the `PBKDF2_ITERATIONS` var and
 * refuses anything outside 1..100000, so a typo fails loudly instead of
 * weakening or breaking every new hash.
 */
export function iterationsFromEnv(value: unknown): number {
  const text = String(value ?? "");
  const count = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(count) || count < 1 || count > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2_ITERATIONS must be an integer from 1 to ${MAX_PBKDF2_ITERATIONS}`);
  }
  return count;
}

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** Hashes a password as typed with PBKDF2-SHA256 and a new 16-byte salt. */
export async function hashPassword(password: string, iterations: number): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, iterations);
  return { hash: toHex(bits), salt: toHex(salt), iterations };
}

/** Checks a password against a stored hash, using the hash's own iteration count. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const bits = await pbkdf2(password, fromHex(stored.salt), stored.iterations);
  const expected = fromHex(stored.hash);
  return constantTimeEqual(new Uint8Array(bits), expected);
}

// Compares every byte whatever the first difference, so the time taken does
// not reveal how much of a guess was right.
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
