import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAuth } from "~/auth/auth";
import { createInvites } from "~/invites";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

async function idOf(table: "members" | "groups", column: "username" | "name", value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${column} = ?1`).bind(value).first<{ id: number }>();
  return row!.id;
}

async function count(sql: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...values).first<{ n: number }>();
  return row!.n;
}

/** The Group names of the Boards on Tonight, in page order. */
function boardNames(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*class="board-name">([^<]*)<\/h2>/g)].map(([, name]) => name);
}

/** Alice owns "Friday" and has made one Invite to it. */
async function setUp() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
  await alice.post("/groups/new", { name: "Friday" });
  const friday = await idOf("groups", "name", "Friday");
  const invites = createInvites({ env, clock: app.clock });
  async function makeInvite(): Promise<string> {
    const made = await invites.makeInvite(await idOf("members", "username", "Alice"), friday, "");
    if (!made.ok) throw new Error("make failed");
    return made.token;
  }
  const token = await makeInvite();
  return { app, alice, friday, invites, token, makeInvite };
}

// inviteFor reads no time, so any clock will do.
const viewOf = (token: string) => createInvites({ env, clock: { now: () => new Date(0) } }).inviteFor(token);
const newLogin = { intent: "create", username: "Bob", password: PASSWORD, colour: "sky" };

describe("the Invite page, logged out", () => {
  it("names the inviter and the Group, offers both ways in, and has no top bar", async () => {
    const { app, token } = await setUp();
    const response = await app.device().open(`/invite/${token}`);
    const html = await response.text();
    const body = bodyOf(html);

    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("Alice invited you to</p><h1>Friday</h1>");
    expect(body).toMatch(/<a class="btn-primary"[^>]*href="\/invite\?mode=create"[^>]*>Create a login<\/a>/);
    expect(body).toMatch(/<a class="btn-secondary"[^>]*href="\/invite\?mode=login"[^>]*>Log in<\/a>/);
    expect(body).not.toContain("top-bar");
    expect(body).not.toContain("<form");
  });

  it("says “You're invited to” once the inviter's login is gone", async () => {
    const { app, token } = await setUp();
    await env.DB.prepare("UPDATE invites SET created_by = NULL").run();
    const body = bodyOf(await (await app.device().open(`/invite/${token}`)).text());
    expect(body).toContain("You&#x27;re invited to</p><h1>Friday</h1>");
  });

  it("shows the sign-up form in create mode and the login form in login mode", async () => {
    const { app, token } = await setUp();
    const browser = await app.deviceWithLink(`/invite/${token}`);
    const create = bodyOf(await (await browser.get("/invite?mode=create")).text());
    expect(create).toContain('name="intent" value="create"');
    expect(create).toContain("Avatar colour");
    expect(create).toMatch(/<button[^>]*type="submit"[^>]*>Create login and join<\/button>/);

    const login = bodyOf(await (await browser.get("/invite?mode=login")).text());
    expect(login).toContain('name="intent" value="login"');
    expect(login).toMatch(/<button[^>]*type="submit"[^>]*>Log in and join<\/button>/);
  });
});

describe("creating a login from an Invite", () => {
  it("creates the login, logs in and joins the Group at once", async () => {
    const { app, friday, token } = await setUp();
    const bob = await app.deviceWithLink(`/invite/${token}`);
    const response = await bob.post("/invite", newLogin);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session=/);
    expect(await count("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?1", friday)).toBe(2);
    expect(boardNames(await (await bob.get("/")).text())).toEqual(["Friday"]);
    expect(await viewOf(token)).toEqual({ usable: false });
  });

  it("re-renders a taken username or a rule error like the Setup Link page and keeps the Invite", async () => {
    const { app, token } = await setUp();
    const taken = await (await app.deviceWithLink(`/invite/${token}`)).post("/invite", { ...newLogin, username: "alice" });
    expect(taken.status).toBe(400);
    expect(bodyOf(await taken.text())).toContain("Error: That username is taken.");

    const short = await (await app.deviceWithLink(`/invite/${token}`)).post("/invite", { ...newLogin, password: "short" });
    expect(short.status).toBe(400);
    expect(bodyOf(await short.text())).toMatch(/id="password-help"[^>]*>Error: /);
    expect((await viewOf(token)).usable).toBe(true);
  });

  it("inserts no Member when the Invite was used between the page load and the submit", async () => {
    const { app, invites, token } = await setUp();
    const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
    await carol.get("/");
    await invites.joinWithInvite(await idOf("members", "username", "Carol"), token);

    // The batch itself refuses, not only the page's check before it.
    const auth = createAuth({ env, clock: app.clock });
    expect(await auth.createLoginFromInvite(token, { username: "Bob", password: PASSWORD, colour: "sky" })).toEqual({
      ok: false,
      reason: "link-unusable",
    });
    const response = await (await app.deviceWithLink(`/invite/${token}`)).post("/invite", newLogin);
    expect(response.status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE username = 'Bob'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sessions s JOIN members m ON m.id = s.member_id WHERE m.username = 'Bob'")).toBe(0);
  });
});

describe("logging in from an Invite", () => {
  it("joins at once with the right password", async () => {
    const { app, friday, token } = await setUp();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    await bob.post("/logout", {});
    await bob.get(`/invite/${token}`);
    const response = await bob.post("/invite", { intent: "login", username: "BOB", password: PASSWORD });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session=/);
    expect(await count("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?1", friday)).toBe(2);
  });

  it("refuses a wrong password with the one login message and keeps the Invite; the login limits apply", async () => {
    const { app, friday, token } = await setUp();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    await bob.post("/logout", {});
    const wrong = { intent: "login", username: "Bob", password: "wrong password!!" };
    await bob.get(`/invite/${token}`);

    const response = await bob.post("/invite", wrong);
    expect(response.status).toBe(401);
    expect(bodyOf(await response.text())).toContain("That username and password do not match.");
    expect((await viewOf(token)).usable).toBe(true);

    for (let i = 0; i < 4; i++) await bob.post("/invite", wrong);
    const locked = await bob.post("/invite", { ...wrong, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?1", friday)).toBe(1);
  });

  it("logs in and lands back on the warning when the Invite is unusable", async () => {
    const { app, token } = await setUp();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    await bob.post("/logout", {});
    await env.DB.prepare("UPDATE invites SET cancelled_at = '2026-11-03T12:00:00.000Z'").run();

    await bob.get(`/invite/${token}`);
    const response = await bob.post("/invite", { intent: "login", username: "Bob", password: PASSWORD });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/invite");
    expect(bodyOf(await (await bob.get("/invite")).text())).toContain("This Invite has been used or cancelled.");
  });
});

describe("joining while logged in", () => {
  it("joins and stacks the Board with the Member's other Boards", async () => {
    const { app, token } = await setUp();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    await bob.post("/groups/new", { name: "Bob's" });
    // Boards stack by when the Member joined, so join a minute later.
    app.clock.set("2026-11-03T12:01:00Z");

    const page = bodyOf(await (await bob.open(`/invite/${token}`)).text());
    expect(page).toMatch(/<button[^>]*type="submit"[^>]*>Join Friday<\/button>/);
    const response = await bob.post("/invite", { intent: "join" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(boardNames(await (await bob.get("/")).text())).toEqual(["Bob&#x27;s", "Friday"]);
  });

  it("tells a Member who is already in, and leaves the Invite unused", async () => {
    const { alice, token } = await setUp();
    const body = bodyOf(await (await alice.open(`/invite/${token}`)).text());
    expect(body).toContain("You&#x27;re already in Friday.");
    expect(body).toMatch(/<a[^>]*href="\/"[^>]*>Go to Tonight<\/a>/);
    expect(body).not.toContain("<form");

    // Showing "already in" used the link up: the cookie is gone.
    expect(alice.cookies.has("__Host-invite")).toBe(false);
    await alice.get(`/invite/${token}`);
    expect((await alice.post("/invite", { intent: "join" })).headers.get("Location")).toBe("/");
    expect(alice.cookies.has("__Host-invite")).toBe(false);
    expect((await viewOf(token)).usable).toBe(true);
  });
});

describe("unusable Invites", () => {
  it("shows used, cancelled and unknown tokens as one warning with no form, and a POST changes nothing", async () => {
    const { app, invites, friday, token: used, makeInvite } = await setUp();
    const cancelled = await makeInvite();
    const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
    await invites.joinWithInvite(await idOf("members", "username", "Carol"), used);
    await env.DB.prepare("UPDATE invites SET cancelled_at = '2026-11-03T12:00:00.000Z' WHERE used_at IS NULL").run();

    const pages = [];
    for (const token of [used, cancelled, "not-a-real-token"]) {
      const response = await app.device().open(`/invite/${token}`);
      expect(response.status, token).toBe(404);
      const body = bodyOf(await response.text());
      expect(body).toContain('<div class="notice-warning"><p class="notice-title">This Invite has been used or cancelled.</p>');
      expect(body).toContain("Ask the Owner of the Group for a new one.");
      expect(body).not.toContain("<form");
      // The page's words, without the router's data, which holds the URL.
      pages.push(body.slice(body.indexOf("<main"), body.indexOf("</main>")));
    }
    expect(new Set(pages).size).toBe(1);

    const before = await count("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?1", friday);
    expect((await (await app.deviceWithLink(`/invite/${cancelled}`)).post("/invite", newLogin)).status).toBe(404);
    const dave = await app.createLogin({ username: "Dave", password: PASSWORD });
    await dave.get(`/invite/${cancelled}`);
    expect((await dave.post("/invite", { intent: "join" })).status).toBe(404);
    await carol.get(`/invite/${used}`);
    expect((await carol.post("/invite", { intent: "join" })).status).toBe(404);
    expect(await count("SELECT COUNT(*) AS n FROM memberships WHERE group_id = ?1", friday)).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE username = 'Bob'")).toBe(0);
  });
});

describe("Invite request safety", () => {
  it("refuses a cross-origin POST", async () => {
    const { app, token } = await setUp();
    const response = await (await app.deviceWithLink(`/invite/${token}`)).post("/invite", newLogin, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM members WHERE username = 'Bob'")).toBe(0);
  });
});
