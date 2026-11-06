import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";

import { hashToken, randomToken } from "~/auth/crypto";
import { usernameKey } from "~/auth/rules";
import { setupLinkStatements } from "~/auth/setup-link-sql";
import { allowGroupsSql } from "~/group-creators-sql";
import type { Clock, PushSender, PushSubscription } from "~/services";
import { encodeBase64Url } from "~/web-push";

import { createWorker } from "../workers/app";

/** A clock that stays where a test puts it. */
export function fixedClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return {
    now: () => new Date(now),
    set(next) {
      now = new Date(next);
    },
  };
}

export interface RecordedPush {
  subscription: PushSubscription;
  payload: string;
}

/**
 * A push sender that records every send instead of delivering it. Each send
 * returns the status scripted for its endpoint, or 201 (accepted) by default,
 * so a test can fake a push service answering 404 or 410. An Error scripted
 * for an endpoint is thrown instead, like a network failure.
 */
export function recordingPushSender(
  statuses: Record<string, number | Error> = {},
): PushSender & { sent: RecordedPush[] } {
  const sent: RecordedPush[] = [];
  return {
    sent,
    async send(subscription, payload) {
      sent.push({ subscription, payload });
      const status = statuses[subscription.endpoint] ?? 201;
      if (status instanceof Error) throw status;
      return { status };
    },
  };
}

/** Encodes bytes as unpadded base64url, the way the Push API serialises keys. */
export { encodeBase64Url as base64Url } from "~/web-push";

/** A push endpoint on an allowed push service host, unique per name. */
export function pushEndpoint(name: string): string {
  return `https://fcm.googleapis.com/fcm/send/${name}`;
}

/**
 * The form fields a browser posts to /push/subscription for an endpoint: keys
 * of the right length (65-byte p256dh, 16-byte auth). The recording push
 * sender never encrypts, so their values do not matter.
 */
export function subscriptionFields(endpoint: string): Record<string, string> {
  return {
    intent: "save",
    endpoint,
    p256dh: encodeBase64Url(new Uint8Array(65).fill(4)),
    auth: encodeBase64Url(new Uint8Array(16).fill(7)),
  };
}

/** The origin test requests are addressed to. */
export const APP_ORIGIN = "https://daily-checkin.test";

export interface DeviceRequestOptions {
  /** The Origin header to send on a POST; null sends none. Defaults to the app's own. */
  origin?: string | null;
}

/**
 * Builds the real Worker around a test clock and a recording push sender, and
 * calls its `fetch` and `scheduled` entry points with the real local bindings.
 * `pushStatuses` scripts the push service's status per subscription endpoint.
 */
export function startApp(
  options: { now?: string; pushStatuses?: Record<string, number | Error> } = {},
) {
  const clock = fixedClock(options.now ?? "2026-11-03T12:00:00Z");
  const push = recordingPushSender(options.pushStatuses);
  const worker = createWorker({ clock, push });

  async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(new URL(path, APP_ORIGIN), init) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  /**
   * One browser on one device: it keeps the cookies the app sets, sends them
   * back, and sends a same-origin Origin header on POSTs like a browser does.
   * Redirects are returned, not followed.
   */
  function device() {
    const cookies = new Map<string, string>();

    async function send(path: string, method: string, form?: Record<string, string>, options: DeviceRequestOptions = {}) {
      const headers = new Headers();
      if (cookies.size > 0) {
        headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      if (method !== "GET" && options.origin !== null) headers.set("Origin", options.origin ?? APP_ORIGIN);
      const response = await fetchApp(path, {
        method,
        headers,
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value === "" || /;\s*max-age=0\b/i.test(cookie)) cookies.delete(name);
        else cookies.set(name, value);
      }
      return response;
    }

    return {
      cookies,
      get: (path: string) => send(path, "GET"),
      /** Opens a link like a browser: follows a 303 with the cookies it set and returns the page. */
      async open(link: string) {
        const first = await send(link, "GET");
        const to = first.headers.get("Location");
        return first.status === 303 && to ? send(to, "GET") : first;
      },
      post: (path: string, form: Record<string, string>, options?: DeviceRequestOptions) =>
        send(path, "POST", form, options),
      /** Turns push on for this device and its session, as the profile's button does. */
      async subscribe(endpoint: string) {
        const response = await send("/push/subscription", "POST", subscriptionFields(endpoint));
        if (response.status !== 204) throw new Error(`subscribe failed with ${response.status}`);
      },
    };
  }

  /** A new device that has opened the link, so its cookie holds the link's token. */
  async function deviceWithLink(link: string) {
    const browser = device();
    await browser.get(link);
    return browser;
  }

  return {
    clock,
    push,
    fetch: fetchApp,
    device,
    deviceWithLink,

    /**
     * Does what the Operator command does, through the same SQL builder, at
     * the clock's current time. Returns the token for /setup/<token>.
     */
    async issueSetupLink(label = "first"): Promise<string> {
      const token = randomToken();
      const statements = setupLinkStatements({ label, tokenHash: await hashToken(token), now: clock.now() });
      await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
      return token;
    },

    /**
     * Does what `npm run operator:allow-groups` does, through the same SQL:
     * gives the login the right to create Groups, or takes it away.
     */
    async allowGroups(username: string, allowed = true): Promise<void> {
      const { results } = await env.DB.prepare(allowGroupsSql(usernameKey(username), allowed)).all();
      if (results.length !== 1) throw new Error(`allowGroups found no login named ${username}`);
    },

    /**
     * Creates a login through a new Setup Link and returns the logged-in
     * device. `canCreateGroups` has the Operator allow it to create Groups.
     */
    async createLogin({
      canCreateGroups = false,
      ...login
    }: { username: string; password: string; colour?: string; canCreateGroups?: boolean }) {
      const token = await this.issueSetupLink(`login ${login.username.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 40));
      const browser = await deviceWithLink(`/setup/${token}`);
      const response = await browser.post("/setup", { colour: "blue", ...login });
      if (response.status !== 302) throw new Error(`createLogin failed with ${response.status}`);
      if (canCreateGroups) await this.allowGroups(login.username);
      return browser;
    },

    /** Runs the hourly Cron Trigger at the clock's current time. */
    async runScheduled(): Promise<void> {
      const ctx = createExecutionContext();
      const controller = createScheduledController({
        scheduledTime: clock.now(),
        cron: "0 * * * *",
      });
      await worker.scheduled(controller, env, ctx);
      await waitOnExecutionContext(ctx);
    },
  };
}
