import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { startApp } from "./harness";

const SESSION_COOKIE = "__Host-session";
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_LINK = "Ask the Operator for a new one.";

function daysAfter(iso: string, days: number, extraSeconds = 0): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS + extraSeconds * 1000).toISOString();
}

const alice = { username: "Alice", password: "correct horse battery", colour: "violet" };

describe("Setup Link", () => {
  it("lets a person create a login and lands them on an empty Tonight", async () => {
    const app = startApp();
    const token = await app.issueSetupLink("first");
    const browser = app.device();

    const form = await browser.get(`/setup/${token}`);
    expect(form.status).toBe(200);
    expect(form.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await form.text();
    expect(html).toContain("Create your login");
    for (const colour of ["Blue", "Sky", "Cyan", "Indigo", "Violet", "Purple", "Pink", "Slate"]) {
      expect(html).toContain(colour);
    }

    const created = await browser.post(`/setup/${token}`, alice);
    expect(created.status).toBe(302);
    expect(created.headers.get("Location")).toBe("/");

    const tonight = await browser.get("/");
    expect(tonight.status).toBe(200);
    const page = await tonight.text();
    expect(page).toContain("Tonight");
    expect(page).toContain("Create a Group");
    expect(page).toContain("Alice");
  });

  it("works only once", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();
    await app.device().post(`/setup/${token}`, alice);

    const again = app.device();
    const opened = await again.get(`/setup/${token}`);
    expect(await opened.text()).toContain(NO_LINK);
    const reused = await again.post(`/setup/${token}`, { ...alice, username: "Mallory" });
    expect(reused.status).toBe(404);
    expect(await reused.text()).toContain(NO_LINK);
    expect(again.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("lets only one of two simultaneous uses through", async () => {
    const app = startApp();
    const token = await app.issueSetupLink();

    const results = await Promise.all([
      app.device().post(`/setup/${token}`, { ...alice, username: "First one" }),
      app.device().post(`/setup/${token}`, { ...alice, username: "Second one" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([302, 404]);
    const { results: members } = await env.DB.prepare("SELECT username FROM members").all();
    expect(members).toHaveLength(1);
  });

  it("gives two simultaneous signups for the same username one login and one taken message", async () => {
    const app = startApp();
    const first = await app.issueSetupLink("one");
    const second = await app.issueSetupLink("two");

    const results = await Promise.all([
      app.device().post(`/setup/${first}`, alice),
      app.device().post(`/setup/${second}`, { ...alice, username: "ALICE" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([302, 400]);
    const loser = results.find((r) => r.status === 400);
    expect(await loser?.text()).toContain("That username is taken.");
  });

  it("expires after 1 hour", async () => {
    const app = startApp({ now: "2026-11-03T12:00:00Z" });
    const token = await app.issueSetupLink();

    app.clock.set("2026-11-03T12:59:59Z");
    expect((await app.device().get(`/setup/${token}`)).status).toBe(200);
    app.clock.set("2026-11-03T13:00:01Z");
    const late = app.device();
    expect(await (await late.get(`/setup/${token}`)).text()).toContain(NO_LINK);
    expect((await late.post(`/setup/${token}`, alice)).status).toBe(404);
  });

  it("is cancelled when the command is rerun for the same label, but not for another label", async () => {
    const app = startApp();
    const first = await app.issueSetupLink("friends");
    const other = await app.issueSetupLink("smoke");
    const second = await app.issueSetupLink("friends");

    expect(await (await app.device().get(`/setup/${first}`)).text()).toContain(NO_LINK);
    expect((await app.device().post(`/setup/${first}`, alice)).status).toBe(404);
    expect((await app.device().get(`/setup/${other}`)).status).toBe(200);
    expect((await app.device().post(`/setup/${second}`, alice)).status).toBe(302);
  });

  it("gives an unknown token the same message", async () => {
    const app = startApp();

    const response = await app.device().get("/setup/not-a-real-token");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain(NO_LINK);
  });
});

describe("Logging in", () => {
  it("accepts the username in any casing", async () => {
    const app = startApp();
    await app.createLogin(alice);
    const phone = app.device();

    const response = await phone.post("/login", { username: "ALICE", password: alice.password });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(await (await phone.get("/")).text()).toContain("Create a Group");
  });

  it("sends a logged-in visit to /login on to Tonight", async () => {
    const app = startApp();
    const browser = await app.createLogin(alice);

    const response = await browser.get("/login");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("shows the identical message for a wrong password and an unknown username", async () => {
    const app = startApp();
    await app.createLogin(alice);

    const wrongPassword = await app.device().post("/login", { username: "Alice", password: "not the password" });
    const unknownUser = await app.device().post("/login", { username: "Bob", password: alice.password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    const message = "That username and password do not match.";
    expect(await wrongPassword.text()).toContain(message);
    expect(await unknownUser.text()).toContain(message);
  });

  it("sends the session cookie HttpOnly, Secure, SameSite=Lax for 90 days", async () => {
    const app = startApp();
    await app.createLogin(alice);

    const response = await app.device().post("/login", { username: "alice", password: alice.password });

    const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
  });
});

describe("Sessions", () => {
  it("renew on each request, so a visit at day 89 keeps the login working at day 120", async () => {
    const start = "2026-11-03T12:00:00Z";
    const app = startApp({ now: start });
    const browser = await app.createLogin(alice);

    app.clock.set(daysAfter(start, 89));
    const visit = await browser.get("/");
    expect(visit.status).toBe(200);
    expect(visit.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);

    app.clock.set(daysAfter(start, 120));
    expect((await browser.get("/")).status).toBe(200);
  });

  it("end after 90 days and 1 second without a visit", async () => {
    const start = "2026-11-03T12:00:00Z";
    const app = startApp({ now: start });
    const browser = await app.createLogin(alice);

    app.clock.set(daysAfter(start, 90, 1));
    const response = await browser.get("/");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("Log out ends only this device; Log out everywhere ends every device", async () => {
    const app = startApp();
    const laptop = await app.createLogin(alice);
    const phone = app.device();
    await phone.post("/login", { username: "Alice", password: alice.password });
    const tablet = app.device();
    await tablet.post("/login", { username: "Alice", password: alice.password });

    const laptopToken = laptop.cookies.get(SESSION_COOKIE) ?? "";
    const loggedOut = await laptop.post("/logout", {});
    expect(loggedOut.status).toBe(302);
    expect(loggedOut.headers.get("Location")).toBe("/login");
    expect((await laptop.get("/")).headers.get("Location")).toBe("/login");
    // The ended session is gone on the server too, not just from this browser.
    const replay = app.device();
    replay.cookies.set(SESSION_COOKIE, laptopToken);
    expect((await replay.get("/")).headers.get("Location")).toBe("/login");
    expect((await phone.get("/")).status).toBe(200);

    const everywhere = await phone.post("/logout-everywhere", {});
    expect(everywhere.headers.get("Location")).toBe("/login");
    expect((await phone.get("/")).headers.get("Location")).toBe("/login");
    expect((await tablet.get("/")).headers.get("Location")).toBe("/login");
  });

  it("shows Log out and Log out everywhere on the profile page", async () => {
    const app = startApp();
    const browser = await app.createLogin(alice);

    const tonight = await (await browser.get("/")).text();
    expect(tonight).toContain('href="/profile"');
    const profile = await (await browser.get("/profile")).text();
    expect(profile).toContain('action="/logout"');
    expect(profile).toContain('action="/logout-everywhere"');
    expect((await app.device().get("/profile")).headers.get("Location")).toBe("/login");
  });

  it("redirects a logged-out visit to Tonight to /login", async () => {
    const app = startApp();

    const response = await app.device().get("/");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("Origin check", () => {
  it("refuses a POST with a mismatched or missing Origin and changes nothing", async () => {
    const app = startApp();
    await app.createLogin(alice);
    const token = await app.issueSetupLink("second");

    const crossSite = await app.device().post(`/setup/${token}`, { ...alice, username: "Mallory" }, {
      origin: "https://evil.example",
    });
    const noOrigin = await app.device().post(`/setup/${token}`, { ...alice, username: "Mallory" }, { origin: null });
    const crossLogin = app.device();
    const login = await crossLogin.post("/login", { username: "Alice", password: alice.password }, {
      origin: "https://evil.example",
    });

    expect(crossSite.status).toBe(403);
    expect(noOrigin.status).toBe(403);
    expect(login.status).toBe(403);
    expect(crossLogin.cookies.has(SESSION_COOKIE)).toBe(false);
    const { results } = await env.DB.prepare("SELECT username FROM members").all();
    expect(results).toEqual([{ username: "Alice" }]);
    expect((await app.device().post(`/setup/${token}`, { ...alice, username: "Bob" })).status).toBe(302);
  });

  it("refuses a cross-origin Log out everywhere, leaving the sessions alone", async () => {
    const app = startApp();
    const browser = await app.createLogin(alice);

    const forged = await browser.post("/logout-everywhere", {}, { origin: "https://evil.example" });

    expect(forged.status).toBe(403);
    expect((await browser.get("/")).status).toBe(200);
  });
});
