import { decodeBase64Url } from "~/push";
import type { PushSubscription } from "~/services";

/**
 * Web Push on WebCrypto alone: the payload encrypted with the aes128gcm
 * content encoding (RFC 8188 and RFC 8291) and the request signed with a
 * VAPID ES256 token (RFC 8292). Apple's push service accepts only aes128gcm,
 * which is why this is not the older aesgcm draft.
 */

/** The record size written into the aes128gcm header; the whole body fits in one record. */
const RECORD_SIZE = 4096;

/** How long a VAPID token is valid. Push services refuse more than 24 hours. */
const TOKEN_LIFETIME_S = 12 * 60 * 60;

const encoder = new TextEncoder();

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypts the payload for one subscription as a single aes128gcm record:
 * a fresh ECDH key pair and salt per message, keys derived from the shared
 * secret and the subscription's auth secret, then the header (salt, record
 * size, sender public key) and the ciphertext.
 */
export async function encryptPayload(payload: string, keys: PushSubscription["keys"]): Promise<Uint8Array<ArrayBuffer>> {
  const receiverPublic = decodeBase64Url(keys.p256dh);
  const auth = decodeBase64Url(keys.auth);
  if (receiverPublic?.length !== 65 || auth?.length !== 16) throw new Error("Invalid subscription keys");

  const sender = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const senderPublic = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    concat(receiverPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256),
  );

  const ikm = await hkdf(auth, shared, concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // One record: the payload, then the last-record delimiter 0x02, no padding.
  const record = concat(encoder.encode(payload), new Uint8Array([2]));
  if (record.length + 16 > RECORD_SIZE) throw new Error("Push payload too large");
  const key = await crypto.subtle.importKey("raw", concat(cek), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: concat(nonce) }, key, record));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, ciphertext);
}

/** The VAPID public key (uncompressed P-256 point, base64url) of a private JWK. */
export function vapidPublicKey(jwk: JsonWebKey): string {
  const x = decodeBase64Url(jwk.x ?? "");
  const y = decodeBase64Url(jwk.y ?? "");
  if (x?.length !== 32 || y?.length !== 32) throw new Error("Invalid VAPID key");
  return encodeBase64Url(concat(new Uint8Array([4]), x, y));
}

/**
 * The Authorization header value for one push service: an ES256 token for
 * the endpoint's origin, signed by the VAPID private key, and the public key.
 */
export async function vapidAuthorization(
  jwk: JsonWebKey,
  { endpoint, subject, now }: { endpoint: string; subject: string; now: Date },
): Promise<string> {
  const { kty, crv, x, y, d } = jwk;
  if (kty !== "EC" || crv !== "P-256" || !d) throw new Error("Invalid VAPID key");
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const part = (value: object) => encodeBase64Url(encoder.encode(JSON.stringify(value)));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + TOKEN_LIFETIME_S,
    sub: subject,
  };
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  // WebCrypto signs ECDSA as raw r || s, which is the JWS ES256 form.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${vapidPublicKey(jwk)}`;
}
