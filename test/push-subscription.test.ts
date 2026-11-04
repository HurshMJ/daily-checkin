import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createPush, validateSubscription } from "~/push";

import { base64Url, pushEndpoint, startApp, subscriptionFields } from "./harness";

const PASSWORD = "correct horse battery";

/** Who each stored endpoint belongs to, by username. */
async function owners(): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    "SELECT s.endpoint, p.username FROM push_subscriptions s JOIN members p ON p.id = s.member_id",
  ).all<{ endpoint: string; username: string }>();
  return Object.fromEntries(results.map((row) => [row.endpoint, row.username]));
}

async function memberId(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  return row!.id;
}

/** A second device for an existing login. */
async function logIn(app: ReturnType<typeof startApp>, username: string) {
  const browser = app.device();
  const response = await browser.post("/login", { username, password: PASSWORD });
  if (response.status !== 302) throw new Error(`login failed with ${response.status}`);
  return browser;
}

const phone = pushEndpoint("alice-phone");

describe("saving a push subscription", () => {
  it("stores a valid subscription for the logged-in Member", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const response = await alice.post("/push/subscription", subscriptionFields(phone));
    expect(response.status).toBe(204);
    expect(await owners()).toEqual({ [phone]: "Alice" });
  });

  it("moves an endpoint saved again from another Member's session to that Member", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    await alice.subscribe(phone);
    await bob.subscribe(phone);
    expect(await owners()).toEqual({ [phone]: "Bob" });
  });

  it.each([
    ["an http endpoint", { endpoint: "http://fcm.googleapis.com/fcm/send/x" }],
    ["an unknown host", { endpoint: "https://evil.example/push" }],
    ["a look-alike host", { endpoint: "https://fcm.googleapis.com.evil.example/push" }],
    ["a host only ending like an allowed one", { endpoint: "https://evilpush.apple.com/push" }],
    ["a port", { endpoint: "https://fcm.googleapis.com:8443/fcm/send/x" }],
    ["credentials in the URL", { endpoint: "https://user:pw@fcm.googleapis.com/fcm/send/x" }],
    ["an endpoint over 2048 characters", { endpoint: pushEndpoint("x".repeat(2049)) }],
    ["no endpoint", { endpoint: "" }],
    ["a p256dh key of the wrong length", { p256dh: base64Url(new Uint8Array(64)) }],
    ["an auth secret of the wrong length", { auth: base64Url(new Uint8Array(17)) }],
    ["a key that is not base64url", { p256dh: "not base64url!" }],
    ["padded base64", { auth: btoa("0123456789abcdef") }],
  ])("refuses %s with 400 and stores nothing", async (_, change) => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const response = await alice.post("/push/subscription", { ...subscriptionFields(phone), ...change });
    expect(response.status).toBe(400);
    expect(await owners()).toEqual({});
  });

  it("accepts every allowed push service host", () => {
    const { p256dh, auth } = subscriptionFields("");
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/a",
      "https://updates.push.services.mozilla.com/wpush/v2/a",
      "https://web.push.apple.com/a",
      "https://wns2-par02p.notify.windows.com/w/?token=a",
      pushEndpoint("y".repeat(2048 - pushEndpoint("").length)),
    ]) {
      expect(validateSubscription({ endpoint, p256dh, auth }), endpoint).not.toBeNull();
    }
  });

  it("refuses an unknown intent", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const response = await alice.post("/push/subscription", { ...subscriptionFields(phone), intent: "other" });
    expect(response.status).toBe(400);
    expect(await owners()).toEqual({});
  });

  it("sends a logged-out post to /login and stores nothing", async () => {
    const app = startApp();
    const response = await app.device().post("/push/subscription", subscriptionFields(phone));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(await owners()).toEqual({});
  });

  it("refuses a cross-origin post", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const response = await alice.post("/push/subscription", subscriptionFields(phone), { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await owners()).toEqual({});
  });
});

describe("turning push off on a device", () => {
  it("deletes the Member's own endpoint only", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    const bobPhone = pushEndpoint("bob-phone");
    await alice.subscribe(phone);
    await bob.subscribe(bobPhone);

    expect((await alice.post("/push/subscription", { intent: "delete", endpoint: bobPhone })).status).toBe(204);
    expect(await owners()).toEqual({ [phone]: "Alice", [bobPhone]: "Bob" });

    expect((await alice.post("/push/subscription", { intent: "delete", endpoint: phone })).status).toBe(204);
    expect(await owners()).toEqual({ [bobPhone]: "Bob" });
  });
});

describe("logging out and push subscriptions", () => {
  it("Log out deletes only that device's subscription", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const laptop = await logIn(app, "Alice");
    const laptopEndpoint = pushEndpoint("alice-laptop");
    await alice.subscribe(phone);
    await laptop.subscribe(laptopEndpoint);

    await alice.post("/logout", {});
    expect(await owners()).toEqual({ [laptopEndpoint]: "Alice" });
  });

  it("Log out everywhere deletes every subscription of the Member and no one else's", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const laptop = await logIn(app, "Alice");
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    const bobPhone = pushEndpoint("bob-phone");
    await alice.subscribe(phone);
    await laptop.subscribe(pushEndpoint("alice-laptop"));
    await bob.subscribe(bobPhone);

    await alice.post("/logout-everywhere", { confirm: "yes" });
    expect(await owners()).toEqual({ [bobPhone]: "Bob" });
  });

  it("a password change deletes the other devices' subscriptions and keeps this one's", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    const laptop = await logIn(app, "Alice");
    await alice.subscribe(phone);
    await laptop.subscribe(pushEndpoint("alice-laptop"));

    const response = await alice.post("/profile", { currentPassword: PASSWORD, newPassword: "a brand new passphrase" });
    expect(response.status).toBe(200);
    expect(await owners()).toEqual({ [phone]: "Alice" });
  });
});

describe("notification toggles", () => {
  it("are all on by default and round-trip off and on", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD });
    const push = createPush({ env, clock: app.clock });
    const alice = await memberId("Alice");

    expect(await push.prefsFor(alice)).toEqual({
      said_yes: true,
      game_on: true,
      game_off: true,
      reminder: true,
      daily_summary: true,
    });
    await push.setPrefs(alice, { game_on: false });
    expect((await push.prefsFor(alice)).game_on).toBe(false);
    await push.setPrefs(alice, { game_on: true });
    expect((await push.prefsFor(alice)).game_on).toBe(true);
  });
});
