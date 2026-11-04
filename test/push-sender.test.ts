import { describe, expect, it } from "vitest";

import { decodeBase64Url } from "~/push";
import { PUSH_TTL_S, PushNotConfiguredError, webPushSender } from "~/services";

import { base64Url } from "./harness";

const SUBJECT = "https://daily-checkin.test";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

/** A VAPID key pair made the way the Operator's step makes one: the private key as JWK JSON. */
async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicKey = base64Url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  return { privateJwk: JSON.stringify(jwk), publicKey, verifyKey: pair.publicKey };
}

/** A browser's subscription: its ECDH key pair and auth secret, and the keys it posts. */
async function browserSubscription() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    publicRaw,
    auth,
    subscription: { endpoint: ENDPOINT, keys: { p256dh: base64Url(publicRaw), auth: base64Url(auth) } },
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
      key,
      bits,
    ),
  );
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const text = (value: string) => new TextEncoder().encode(value);

/** Decrypts an aes128gcm Web Push body the way the browser does (RFC 8188 and RFC 8291). */
async function decrypt(body: Uint8Array, browser: Awaited<ReturnType<typeof browserSubscription>>): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20];
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);

  const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, browser.pair.privateKey, 256),
  );
  const ikm = await hkdf(browser.auth, shared, concat(text("WebPush: info\0"), browser.publicRaw, serverPublic), 256);
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 96);
  const key = await crypto.subtle.importKey("raw", cek as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> }, key, ciphertext),
  );
  // The record ends with the delimiter 0x02, then zero padding.
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return new TextDecoder().decode(padded.slice(0, end));
}

/** A fetch that records the one request and answers with `status`. */
function recordingFetch(status: number) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("the production push sender", () => {
  it("posts an aes128gcm push with VAPID ES256 auth to the endpoint and returns the push service's status", async () => {
    const vapid = await vapidPair();
    const browser = await browserSubscription();
    const { fetch, requests } = recordingFetch(201);
    const payload = JSON.stringify({ title: "Game On: Friday", body: "3 said Yes", url: "/groups/1", tag: "game-on-1-2026-11-03" });

    const result = await webPushSender({ privateJwk: vapid.privateJwk, subject: SUBJECT, fetch }).send(
      browser.subscription,
      payload,
    );

    expect(result).toEqual({ status: 201 });
    expect(requests).toHaveLength(1);
    const [{ url, init }] = requests;
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(headers.get("TTL")).toBe(String(PUSH_TTL_S));
    expect(headers.get("Urgency")).toBe("high");
    expect(headers.get("Topic")).toBe("game-on-1-2026-11-03");

    // Authorization: vapid t=<JWT>, k=<public key>, signed for the endpoint's origin by the app's URL.
    const authorization = headers.get("Authorization")!;
    const [, jwt, key] = authorization.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(key).toBe(vapid.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(jwt.split(".")[1])!));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe(SUBJECT);
    expect(claims.exp - Date.now() / 1000).toBeGreaterThan(0);
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 60 * 60);
    const [header, claimsPart, signature] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(header)!))).toEqual({ typ: "JWT", alg: "ES256" });
    const signed = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      vapid.verifyKey,
      decodeBase64Url(signature)! as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${header}.${claimsPart}`),
    );
    expect(signed).toBe(true);

    // The browser decrypts exactly the payload the app built.
    const body = new Uint8Array(init.body as ArrayBuffer);
    expect(await decrypt(body, browser)).toBe(payload);
  });

  it("sends someone said Yes with normal urgency", async () => {
    const vapid = await vapidPair();
    const browser = await browserSubscription();
    const { fetch, requests } = recordingFetch(201);
    await webPushSender({ privateJwk: vapid.privateJwk, subject: SUBJECT, fetch }).send(
      browser.subscription,
      JSON.stringify({ title: "Alice said Yes", body: "", url: "/", tag: "said-yes-1-2026-11-03" }),
    );
    expect(new Headers(requests[0].init.headers).get("Urgency")).toBe("normal");
  });

  it.each([404, 410, 500])("reports a %i from the push service as the result", async (status) => {
    const vapid = await vapidPair();
    const browser = await browserSubscription();
    const { fetch } = recordingFetch(status);
    const result = await webPushSender({ privateJwk: vapid.privateJwk, subject: SUBJECT, fetch }).send(
      browser.subscription,
      JSON.stringify({ title: "t", body: "", url: "/", tag: "said-yes-1" }),
    );
    expect(result).toEqual({ status });
  });

  it("sends nothing and says why when the VAPID private key is not JWK JSON", async () => {
    const browser = await browserSubscription();
    const { fetch, requests } = recordingFetch(201);
    const send = webPushSender({ privateJwk: "not json", subject: SUBJECT, fetch }).send(browser.subscription, "{}");
    await expect(send).rejects.toThrow("VAPID_PRIVATE_KEY is not JWK JSON");
    expect(requests).toEqual([]);
  });

  it("sends nothing and says why when the VAPID key is not a P-256 private key", async () => {
    const browser = await browserSubscription();
    const { fetch, requests } = recordingFetch(201);
    const publicOnly = JSON.stringify({ kty: "EC", crv: "P-256", x: "AA", y: "AA" });
    const send = webPushSender({ privateJwk: publicOnly, subject: SUBJECT, fetch }).send(browser.subscription, "{}");
    await expect(send).rejects.toThrow("VAPID_PRIVATE_KEY is not a P-256 private key");
    expect(requests).toEqual([]);
  });

  it("sends nothing and says why when the VAPID private key is missing", async () => {
    const browser = await browserSubscription();
    const { fetch, requests } = recordingFetch(201);
    const send = webPushSender({ privateJwk: undefined, subject: SUBJECT, fetch }).send(browser.subscription, "{}");
    await expect(send).rejects.toThrow(PushNotConfiguredError);
    await expect(send).rejects.toThrow("VAPID_PRIVATE_KEY is not set");
    expect(requests).toEqual([]);
  });
});
