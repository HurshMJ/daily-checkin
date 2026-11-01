import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";

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

/** A push sender that records every send instead of delivering it. */
export function recordingPushSender(): PushSender & { sent: RecordedPush[] } {
  const sent: RecordedPush[] = [];
  return {
    sent,
    async send(subscription, payload) {
      sent.push({ subscription, payload });
    },
  };
}

/**
 * Builds the real Worker around a test clock and a recording push sender, and
 * calls its `fetch` and `scheduled` entry points with the real local bindings.
 */
export function startApp(options: { now?: string } = {}) {
  const clock = fixedClock(options.now ?? "2026-11-03T12:00:00Z");
  const push = recordingPushSender();
  const worker = createWorker({ clock, push });

  return {
    clock,
    push,

    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(new URL(path, "https://daily-checkin.test"), init) as Request<
          unknown,
          IncomingRequestCfProperties
        >,
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
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
