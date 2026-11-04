import { createContext } from "react-router";

import { encryptPayload, vapidAuthorization } from "~/web-push";

declare global {
  interface Env {
    /**
     * The VAPID private key as JWK JSON: a Worker secret set by
     * scripts/operator-setup.sh, so absent until the Operator runs it.
     */
    VAPID_PRIVATE_KEY?: string;
  }
}

/**
 * The services every request and scheduled run receives at the Worker
 * boundary. Production wires real implementations; tests pass fakes to
 * `createWorker()` so they can control time and observe pushes. Nothing else
 * is swapped out: D1 and the rest of `env` are always the real bindings.
 */
export interface Services {
  clock: Clock;
  push: PushSender;
}

/** Returns the current instant. Tests set it; production reads the system time. */
export interface Clock {
  now(): Date;
}

/** A browser push subscription, as the Push API serialises it. */
export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * The push service's answer to one send. `status` is its HTTP status: 201 means
 * accepted, and 404 or 410 means the subscription is gone and should be deleted.
 */
export interface PushResult {
  status: number;
}

/** Delivers one push payload to one subscription. */
export interface PushSender {
  send(subscription: PushSubscription, payload: string): Promise<PushResult>;
}

/**
 * Thrown by a push sender that cannot send at all, such as production without
 * its VAPID key. Its message is logged as is, so it must never hold a secret.
 */
export class PushNotConfiguredError extends Error {
  override name = "PushNotConfiguredError";
}

export const systemClock: Clock = {
  now: () => new Date(Date.now()),
};

/**
 * How long a push service keeps trying to deliver, in seconds. Event pushes
 * go stale by the Reset, so a few hours is enough.
 */
export const PUSH_TTL_S = 4 * 60 * 60;

/** A Web Push Topic header: at most 32 URL-safe base64 characters. */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The production push sender: Web Push with VAPID and aes128gcm, built on
 * WebCrypto in app/web-push.ts, then one fetch to the subscription's push
 * service. `privateJwk` is the VAPID private key as JWK JSON and `subject`
 * the app's https URL. Without the key every send throws
 * PushNotConfiguredError, so nothing is sent and the caller logs it. Game On
 * and Game Off go out with high urgency, everything else normal; the
 * payload's tag becomes the Topic, so a newer push with the same tag replaces
 * an undelivered one.
 */
export function webPushSender({
  privateJwk,
  subject,
  clock = systemClock,
  fetch: send = fetch,
}: {
  privateJwk: string | undefined;
  subject: string;
  clock?: Clock;
  fetch?: typeof fetch;
}): PushSender {
  return {
    async send(subscription, payload) {
      if (!privateJwk) throw new PushNotConfiguredError("VAPID_PRIVATE_KEY is not set");
      let jwk: JsonWebKey;
      try {
        jwk = JSON.parse(privateJwk) as JsonWebKey;
      } catch {
        throw new PushNotConfiguredError("VAPID_PRIVATE_KEY is not JWK JSON");
      }
      let authorization: string;
      try {
        authorization = await vapidAuthorization(jwk, { endpoint: subscription.endpoint, subject, now: clock.now() });
      } catch {
        throw new PushNotConfiguredError("VAPID_PRIVATE_KEY is not a P-256 private key");
      }
      const parsed = JSON.parse(payload) as { tag?: unknown };
      const tag = typeof parsed.tag === "string" ? parsed.tag : "";
      const headers = new Headers({
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_S),
        Urgency: tag.startsWith("game-") ? "high" : "normal",
      });
      if (TOPIC.test(tag)) headers.set("Topic", tag);
      const body = await encryptPayload(payload, subscription.keys);
      const response = await send(subscription.endpoint, { method: "POST", headers, body });
      await response.body?.cancel();
      return { status: response.status };
    },
  };
}

/** The services production runs on, built from `env` at the Worker boundary. */
export function productionServices(env: Env): Services {
  return {
    clock: systemClock,
    push: webPushSender({ privateJwk: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }),
  };
}

/** What route loaders and actions read with `context.get(appContext)`. */
export interface AppContext extends Services {
  env: Env;
  ctx: ExecutionContext;
}

export const appContext = createContext<AppContext>();
