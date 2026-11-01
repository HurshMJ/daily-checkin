import { createContext } from "react-router";

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

export const systemClock: Clock = {
  now: () => new Date(Date.now()),
};

/** Placeholder until real Web Push delivery lands; any send fails loudly. */
export const unconfiguredPushSender: PushSender = {
  async send() {
    throw new Error("Push sender not configured");
  },
};

export const productionServices: Services = {
  clock: systemClock,
  push: unconfiguredPushSender,
};

/** What route loaders and actions read with `context.get(appContext)`. */
export interface AppContext extends Services {
  env: Env;
  ctx: ExecutionContext;
}

export const appContext = createContext<AppContext>();
