import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { hashToken, randomToken } from "~/auth/crypto";
import { memberLookupSql, operatorResetLinkStatements } from "~/auth/reset-link-sql";
import { sqlText } from "~/sql-text";
import { createResetLinks } from "~/auth/reset-links";
import { createInvites } from "~/invites";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";

async function idOf(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  if (!row) throw new Error(`no member ${username}`);
  return row.id;
}

/**
 * Alice owns "Friday" with Bob in it; Carol owns "Other", which Bob is not
 * in. Each is logged in on their own device.
 */
async function friday() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
  const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
  const carol = await app.createLogin({ username: "Carol", password: PASSWORD, canCreateGroups: true });
  await alice.post("/groups/new", { name: "Friday" });
  await carol.post("/groups/new", { name: "Other" });
  const ids = { alice: await idOf("Alice"), bob: await idOf("Bob"), carol: await idOf("Carol") };
  const groupId = (await env.DB.prepare("SELECT id FROM groups WHERE name = 'Friday'").first<{ id: number }>())!.id;
  const invites = createInvites({ env, clock: app.clock });
  const invite = await invites.makeInvite(ids.alice, groupId, "");
  if (!invite.ok) throw new Error("invite failed");
  expect(await invites.joinWithInvite(ids.bob, invite.token)).toBe("joined");
  const links = createResetLinks({ env, clock: app.clock });
  return { app, alice, bob, carol, ids, groupId, links };
}

async function makeOk(links: ReturnType<typeof createResetLinks>, makerId: number, memberId: number): Promise<string> {
  const made = await links.make(makerId, memberId);
  if (!made.ok) throw new Error("make failed");
  return made.token;
}

/** Issues an Operator link the way scripts/reset-link.ts does, through the same SQL builder. */
async function operatorLink(app: ReturnType<typeof startApp>, memberId: number): Promise<string> {
  const token = randomToken();
  const statements = operatorResetLinkStatements({ memberId, tokenHash: await hashToken(token), now: app.clock.now() });
  await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
  return token;
}

describe("making a Password Reset Link", () => {
  it("stores only the token's SHA-256", async () => {
    const { ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    const { results } = await env.DB.prepare("SELECT * FROM password_reset_links").all();
    expect(results).toEqual([
      {
        token_hash: await hashToken(token),
        member_id: ids.bob,
        made_by: ids.alice,
        created_at: "2026-11-03T12:00:00.000Z",
        expires_at: "2026-11-03T13:00:00.000Z",
        used_at: null,
        cancelled_at: null,
      },
    ]);
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("is refused for a non-Owner, an Owner of an unrelated Group, and the Owner themselves", async () => {
    const { ids, links } = await friday();
    expect(await links.make(ids.bob, ids.alice)).toEqual({ ok: false, reason: "not-allowed" });
    expect(await links.make(ids.carol, ids.bob)).toEqual({ ok: false, reason: "not-allowed" });
    expect(await links.make(ids.alice, ids.alice)).toEqual({ ok: false, reason: "not-allowed" });
    expect(await links.make(ids.alice, ids.carol)).toEqual({ ok: false, reason: "not-allowed" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM password_reset_links").first<{ n: number }>())!.n).toBe(0);
  });

  it("refused, it cancels nothing", async () => {
    const { app, ids, links } = await friday();
    const token = await operatorLink(app, ids.bob);
    await links.make(ids.carol, ids.bob);
    expect(await links.view(token)).toEqual({ username: "Bob" });
  });

  it("makes every older link of the Member unusable, an Operator link included", async () => {
    const { app, ids, links } = await friday();
    const fromOperator = await operatorLink(app, ids.bob);
    const first = await makeOk(links, ids.alice, ids.bob);
    expect(await links.view(fromOperator)).toBeNull();
    const second = await makeOk(links, ids.alice, ids.bob);
    expect(await links.view(first)).toBeNull();
    expect(await links.view(second)).toEqual({ username: "Bob" });

    // An Operator link supersedes the Owner's in turn.
    const third = await operatorLink(app, ids.bob);
    expect(await links.view(second)).toBeNull();
    expect((await links.setPassword(second, NEW_PASSWORD)).ok).toBe(false);
    expect((await links.setPassword(third, NEW_PASSWORD)).ok).toBe(true);
  });
});

describe("using a Password Reset Link", () => {
  it("works for exactly 1 hour", async () => {
    const { app, ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    app.clock.set("2026-11-03T12:59:59.999Z");
    expect(await links.view(token)).toEqual({ username: "Bob" });
    app.clock.set("2026-11-03T13:00:00.000Z");
    expect(await links.view(token)).toBeNull();
    expect(await links.setPassword(token, NEW_PASSWORD)).toEqual({ ok: false, reason: "unusable" });
  });

  it("works once", async () => {
    const { ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    expect(await links.setPassword(token, NEW_PASSWORD)).toEqual({ ok: true });
    expect(await links.setPassword(token, "another fresh passphrase")).toEqual({ ok: false, reason: "unusable" });
  });

  it("lets only one of two racing uses set a password", async () => {
    const { app, ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    const results = await Promise.all([
      links.setPassword(token, NEW_PASSWORD),
      links.setPassword(token, "another fresh passphrase"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = results[0].ok ? NEW_PASSWORD : "another fresh passphrase";
    expect((await app.device().post("/login", { username: "Bob", password: winner })).status).toBe(302);
  });

  it("is refused once cancelled, and only its maker can cancel it", async () => {
    const { app, ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    expect(await links.cancel(ids.carol, ids.bob)).toEqual({ ok: false, reason: "not-pending" });
    expect(await links.cancel(ids.bob, ids.bob)).toEqual({ ok: false, reason: "not-pending" });
    expect(await links.view(token)).toEqual({ username: "Bob" });

    expect(await links.cancel(ids.alice, ids.bob)).toEqual({ ok: true });
    expect(await links.view(token)).toBeNull();
    expect(await links.setPassword(token, NEW_PASSWORD)).toEqual({ ok: false, reason: "unusable" });
    expect(await links.cancel(ids.alice, ids.bob)).toEqual({ ok: false, reason: "not-pending" });

    // The Owner cannot cancel the Operator's link.
    const fromOperator = await operatorLink(app, ids.bob);
    expect(await links.cancel(ids.alice, ids.bob)).toEqual({ ok: false, reason: "not-pending" });
    expect(await links.view(fromOperator)).toEqual({ username: "Bob" });
  });

  it("applies the password rules of Change password and changes nothing on a refusal", async () => {
    const { ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    expect(await links.setPassword(token, "short")).toEqual({
      ok: false,
      reason: "password",
      message: "Use 12 to 128 characters.",
    });
    expect(await links.setPassword(token, "x".repeat(129))).toMatchObject({ reason: "password" });
    expect(await links.setPassword(token, "bob")).toMatchObject({ reason: "password" });
    expect(await links.view(token)).toEqual({ username: "Bob" });
  });

  it("refuses the Member's username as a password", async () => {
    const app = startApp();
    const owner = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    await app.createLogin({ username: "Bob the twelfth", password: PASSWORD });
    await owner.post("/groups/new", { name: "Friday" });
    const ids = { alice: await idOf("Alice"), bob: await idOf("Bob the twelfth") };
    const groupId = (await env.DB.prepare("SELECT id FROM groups").first<{ id: number }>())!.id;
    const invites = createInvites({ env, clock: app.clock });
    const invite = await invites.makeInvite(ids.alice, groupId, "");
    if (!invite.ok) throw new Error("invite failed");
    await invites.joinWithInvite(ids.bob, invite.token);
    const links = createResetLinks({ env, clock: app.clock });
    const token = await makeOk(links, ids.alice, ids.bob);
    expect(await links.setPassword(token, "BOB THE TWELFTH")).toEqual({
      ok: false,
      reason: "password",
      message: "Choose a password that is not your username.",
    });
  });

  it("sets the password: the old one is refused and the new one accepted", async () => {
    const { app, ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    await links.setPassword(token, NEW_PASSWORD);
    expect((await app.device().post("/login", { username: "Bob", password: PASSWORD })).status).toBe(401);
    expect((await app.device().post("/login", { username: "Bob", password: NEW_PASSWORD })).status).toBe(302);
  });

  it("ends every session and push subscription of the Member and sets the notice flag", async () => {
    const { app, alice, bob, ids, links } = await friday();
    const laptop = app.device();
    expect((await laptop.post("/login", { username: "Bob", password: PASSWORD })).status).toBe(302);
    await bob.subscribe("https://fcm.googleapis.com/fcm/send/bob-phone");
    await laptop.subscribe("https://fcm.googleapis.com/fcm/send/bob-laptop");
    await alice.subscribe("https://fcm.googleapis.com/fcm/send/alice-phone");

    const token = await makeOk(links, ids.alice, ids.bob);
    expect(await links.setPassword(token, NEW_PASSWORD)).toEqual({ ok: true });

    const count = async (sql: string) => (await env.DB.prepare(sql).bind(ids.bob).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE member_id = ?1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?1")).toBe(0);
    expect(await count("SELECT password_reset_notice AS n FROM members WHERE id = ?1")).toBe(1);
    expect((await bob.get("/profile")).headers.get("Location")).toBe("/login");
    expect((await laptop.get("/profile")).headers.get("Location")).toBe("/login");
    // Alice is untouched.
    expect((await alice.get("/profile")).status).toBe(200);
    expect(await count(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id != ?1`)).toBe(1);
  });

  it("clears the username's login failures", async () => {
    const { app, ids, links } = await friday();
    for (let i = 0; i < 5; i++) await app.device().post("/login", { username: "Bob", password: "wrong password!" });
    expect((await app.device().post("/login", { username: "Bob", password: PASSWORD })).status).toBe(401);

    await links.setPassword(await makeOk(links, ids.alice, ids.bob), NEW_PASSWORD);
    expect((await app.device().post("/login", { username: "Bob", password: NEW_PASSWORD })).status).toBe(302);
  });
});

describe("the Owner's pending links", () => {
  it("lists the maker's usable links for the Group's Members, for the Owner only", async () => {
    const { app, ids, groupId, links } = await friday();
    expect(await links.pending(ids.alice, groupId)).toEqual([]);
    expect(await links.pending(ids.bob, groupId)).toBeNull();

    await makeOk(links, ids.alice, ids.bob);
    expect(await links.pending(ids.alice, groupId)).toEqual([{ memberId: ids.bob, expiresAt: "2026-11-03T13:00:00.000Z" }]);

    app.clock.set("2026-11-03T13:00:00Z");
    expect(await links.pending(ids.alice, groupId)).toEqual([]);

    // An Operator link is not the Owner's to list.
    await operatorLink(app, ids.bob);
    expect(await links.pending(ids.alice, groupId)).toEqual([]);
  });
});

describe("the Operator's reset-link SQL", () => {
  it("quotes text literals by doubling single quotes", () => {
    expect(sqlText("o'brien")).toBe("'o''brien'");
    expect(memberLookupSql("o'brien")).toBe("SELECT id FROM members WHERE username_lower = 'o''brien';");
    expect(() => sqlText("a\u0000b")).toThrow();
  });

  it("finds a username with a quote or non-ASCII letters", async () => {
    const app = startApp();
    await app.createLogin({ username: "O'Brien", password: PASSWORD });
    await app.createLogin({ username: "Zoë Ångström", password: PASSWORD });
    for (const key of ["o'brien", "zoë ångström"]) {
      const row = await env.DB.prepare(memberLookupSql(key)).first<{ id: number }>();
      expect(row?.id, key).toBeGreaterThan(0);
    }
    expect(await env.DB.prepare(memberLookupSql("o'brien' OR '1'='1")).first()).toBeNull();
  });

  it("cancels the Member's usable links and inserts the hash with made_by NULL", () => {
    const tokenHash = "a".repeat(64);
    expect(operatorResetLinkStatements({ memberId: 7, tokenHash, now: new Date("2026-11-03T12:00:00Z") })).toEqual([
      "UPDATE password_reset_links SET cancelled_at = '2026-11-03T12:00:00.000Z' WHERE member_id = 7 AND password_reset_links.used_at IS NULL AND password_reset_links.cancelled_at IS NULL AND password_reset_links.expires_at > '2026-11-03T12:00:00.000Z';",
      `INSERT INTO password_reset_links (token_hash, member_id, made_by, created_at, expires_at) VALUES ('${tokenHash}', 7, NULL, '2026-11-03T12:00:00.000Z', '2026-11-03T13:00:00.000Z');`,
    ]);
    expect(() => operatorResetLinkStatements({ memberId: 0, tokenHash, now: new Date() })).toThrow();
    expect(() => operatorResetLinkStatements({ memberId: 7, tokenHash: "x'", now: new Date() })).toThrow();
  });
});

/** The page's words, without the router's data or React's text markers. */
async function mainOf(response: Response): Promise<string> {
  const html = (await response.text()).replaceAll("<!-- -->", "");
  return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
}

const CLEARED_RESET = "__Host-reset=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/";

describe("the Set a new password page", () => {
  it("names the username, warns about every device and works without JavaScript", async () => {
    const { app, ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    const response = await app.device().open(`/reset/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const main = await mainOf(response);
    expect(main).toContain("<h1>Set a new password</h1>");
    expect(main).toContain("For @Bob.");
    expect(main).toContain("Setting a new password logs out @Bob on every device");
    expect(main).toMatch(/<form[^>]* method="post"/);
    expect(main).toMatch(/name="newPassword"[^>]*autoComplete="new-password"|autoComplete="new-password"[^>]*name="newPassword"/);
    expect(main).toContain('name="confirmPassword"');
    expect(main).not.toContain("top-bar");
  });

  it("shows the unusable notice with 404 for no cookie, and for a used, expired or cancelled link", async () => {
    const { app, ids, links } = await friday();
    const without = await app.device().get("/reset");
    expect(without.status).toBe(404);
    expect(await mainOf(without)).toContain("This Password Reset Link does not work.");

    const used = await makeOk(links, ids.alice, ids.bob);
    await links.setPassword(used, NEW_PASSWORD);
    const expired = await makeOk(links, ids.alice, ids.bob);
    app.clock.set("2026-11-03T13:00:00Z");
    const cancelled = await makeOk(links, ids.alice, ids.bob);
    await links.cancel(ids.alice, ids.bob);
    for (const token of [used, expired, cancelled, randomToken()]) {
      const response = await app.device().open(`/reset/${token}`);
      expect(response.status).toBe(404);
      expect(await mainOf(response)).toContain("Ask an Owner of your Group for a new one.");
    }
  });

  it("refuses two different passwords or a short one and changes nothing", async () => {
    const { app, ids, links } = await friday();
    const browser = await app.deviceWithLink(`/reset/${await makeOk(links, ids.alice, ids.bob)}`);
    const differ = await browser.post("/reset", { newPassword: NEW_PASSWORD, confirmPassword: "something else entirely" });
    expect(differ.status).toBe(400);
    const differMain = await mainOf(differ);
    expect(differMain).toContain("The two passwords are not the same.");
    expect(differMain).not.toContain(NEW_PASSWORD);

    const short = await browser.post("/reset", { newPassword: "short", confirmPassword: "short" });
    expect(short.status).toBe(400);
    expect(await mainOf(short)).toContain("Use 12 to 128 characters.");
    expect((await app.device().post("/login", { username: "Bob", password: PASSWORD })).status).toBe(302);
  });

  it("sets the password, clears the cookie and sends the Member to log in with a fixed notice", async () => {
    const { app, bob, ids, links } = await friday();
    const browser = await app.deviceWithLink(`/reset/${await makeOk(links, ids.alice, ids.bob)}`);
    const response = await browser.post("/reset", { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login?notice=password-set");
    expect(response.headers.getSetCookie()).toContain(CLEARED_RESET);
    expect(browser.cookies.has("__Host-reset")).toBe(false);
    expect(browser.cookies.has("__Host-session")).toBe(false);

    const login = await mainOf(await browser.get("/login?notice=password-set"));
    expect(login).toContain("Password set");
    expect(login).toContain("Log in with your new password.");
    // Bob's phone was logged out.
    expect((await bob.get("/")).headers.get("Location")).toBe("/login");
  });

  it("shows only the fixed login notices", async () => {
    const app = startApp();
    const plain = await mainOf(await app.device().get("/login"));
    for (const key of ["anything", "<b>hi</b>", "constructor", "__proto__"]) {
      const main = await mainOf(await app.device().get(`/login?notice=${encodeURIComponent(key)}`));
      expect(main, key).toBe(plain);
    }
  });

  it("puts the token in no page, link, form or Location after the first request", async () => {
    const { app, ids, links } = await friday();
    const token = await makeOk(links, ids.alice, ids.bob);
    const browser = app.device();
    const first = await browser.get(`/reset/${token}`);
    expect(first.status).toBe(303);
    expect(first.headers.get("Location")).toBe("/reset");
    const later = [
      await browser.get("/reset"),
      await browser.post("/reset", { newPassword: "short", confirmPassword: "short" }),
      await browser.post("/reset", { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
    ];
    expect(later.map((r) => r.status)).toEqual([200, 400, 302]);
    for (const response of later) {
      expect(response.headers.get("Location") ?? "").not.toContain(token);
      expect(await response.text()).not.toContain(token);
    }
  });
});

describe("the notice after a reset", () => {
  it("shows once on Tonight after the next login, never again", async () => {
    const { app, ids, links } = await friday();
    await links.setPassword(await makeOk(links, ids.alice, ids.bob), NEW_PASSWORD);

    const bob = app.device();
    const login = await bob.post("/login", { username: "Bob", password: NEW_PASSWORD });
    expect(login.headers.get("Location")).toBe("/");
    const first = await mainOf(await bob.get("/"));
    expect(first).toContain("Your password was reset");
    expect(first).toContain("If you did not ask for this, tell your Group&#x27;s Owner.");
    expect(await mainOf(await bob.get("/"))).not.toContain("Your password was reset");

    const again = app.device();
    await again.post("/login", { username: "Bob", password: NEW_PASSWORD });
    expect(await mainOf(await again.get("/"))).not.toContain("Your password was reset");
  });

  it("shows on the empty Tonight too, and never for a Member whose password was not reset", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
    expect(await mainOf(await alice.get("/"))).not.toContain("Your password was reset");
    const aliceId = await idOf("Alice");
    await env.DB.prepare("UPDATE members SET password_reset_notice = 1 WHERE id = ?1").bind(aliceId).run();
    expect(await mainOf(await alice.get("/"))).toContain("Your password was reset");
    expect(await mainOf(await alice.get("/"))).not.toContain("Your password was reset");
  });
});
