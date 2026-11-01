import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";

import { hashToken, randomToken } from "~/auth/crypto";
import { setupLinkStatements } from "~/auth/setup-link-sql";
import type { Clock, PushSender, PushSubscription } from "~/services";

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
 * so a test can fake a push service answering 404 or 410.
 */
export function recordingPushSender(
  statuses: Record<string, number> = {},
): PushSender & { sent: RecordedPush[] } {
  const sent: RecordedPush[] = [];
  return {
    sent,
    async send(subscription, payload) {
      sent.push({ subscription, payload });
      return { status: statuses[subscription.endpoint] ?? 201 };
    },
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
  options: { now?: string; pushStatuses?: Record<string, number> } = {},
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
      post: (path: string, form: Record<string, string>, options?: DeviceRequestOptions) =>
        send(path, "POST", form, options),
    };
  }

  return {
    clock,
    push,
    fetch: fetchApp,
    device,

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

    /** Creates a login through a new Setup Link and returns the logged-in device. */
    async createLogin(login: { username: string; password: string; colour?: string }) {
      const token = await this.issueSetupLink(`login ${login.username.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 40));
      const browser = device();
      const response = await browser.post(`/setup/${token}`, { colour: "blue", ...login });
      if (response.status !== 302) throw new Error(`createLogin failed with ${response.status}`);
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
