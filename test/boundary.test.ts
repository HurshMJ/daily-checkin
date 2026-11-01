import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { productionServices } from "~/services";

import { startApp } from "./harness";

describe("Worker boundary", () => {
  it("serves pages through fetch", async () => {
    const app = startApp();

    const response = await app.fetch("/login");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(await response.text()).toContain("Daily Check-in");
  });

  it("sends a logged-out visit to Tonight to /login", async () => {
    const app = startApp();

    const response = await app.fetch("/");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("reports the injected clock's time and a reachable database", async () => {
    const app = startApp({ now: "2026-11-03T12:59:00Z" });

    const first = await app.fetch("/healthz");
    app.clock.set("2026-11-04T02:00:00Z");
    const second = await app.fetch("/healthz");

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, now: "2026-11-03T12:59:00.000Z" });
    expect(await second.json()).toEqual({ ok: true, now: "2026-11-04T02:00:00.000Z" });
  });

  it("runs the scheduled handler with the injected push sender and sends nothing yet", async () => {
    const app = startApp({ now: "2026-11-03T13:00:00Z" });

    await app.runScheduled();

    expect(app.push.sent).toEqual([]);
  });

  it("lets a test script the push service's status for one endpoint", async () => {
    const gone = { endpoint: "https://push.example/gone", keys: { p256dh: "k", auth: "a" } };
    const live = { endpoint: "https://push.example/live", keys: { p256dh: "k", auth: "a" } };
    const app = startApp({ pushStatuses: { [gone.endpoint]: 410 } });

    const goneResult = await app.push.send(gone, '{"title":"one"}');
    const liveResult = await app.push.send(live, '{"title":"two"}');

    expect(goneResult).toEqual({ status: 410 });
    expect(liveResult).toEqual({ status: 201 });
    expect(app.push.sent).toEqual([
      { subscription: gone, payload: '{"title":"one"}' },
      { subscription: live, payload: '{"title":"two"}' },
    ]);
  });

  it("returns 404 for unknown pages", async () => {
    const app = startApp();

    const response = await app.fetch("/no-such-page");

    expect(response.status).toBe(404);
  });
});

describe("clean database per test", () => {
  it("writes a row in one test", async () => {
    await env.DB.prepare(
      "INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-11-02')",
    ).run();

    const { results } = await env.DB.prepare("SELECT * FROM scheduler_state").all();
    expect(results).toHaveLength(1);
  });

  // Proves isolation only when it runs after "writes a row in one test" above,
  // which Vitest does by default (tests in a file run in order). Run on its own
  // with -t, it passes without proving anything.
  it("does not see that row in the next test", async () => {
    const { results } = await env.DB.prepare("SELECT * FROM scheduler_state").all();
    expect(results).toEqual([]);
  });
});

describe("production services", () => {
  it("refuses to send pushes until a real sender is configured", async () => {
    await expect(
      productionServices.push.send(
        { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } },
        "{}",
      ),
    ).rejects.toThrow("Push sender not configured");
  });

  it("reads the system time", () => {
    const before = Date.now();
    const now = productionServices.clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
