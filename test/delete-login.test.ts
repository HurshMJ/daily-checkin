import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createAuth } from "~/auth/auth";
import { createResetLinks } from "~/auth/reset-links";
import { createInvites } from "~/invites";

import { pushEndpoint, startApp } from "./harness";

const PASSWORD = "correct horse battery";
const RESET_4_NOV = "2026-11-04T02:00:00Z";

async function idOf(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  if (!row) throw new Error(`no member ${username}`);
  return row.id;
}

async function groupId(name: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT id FROM groups WHERE name = ?1").bind(name).first<{ id: number }>();
  return row?.id ?? null;
}

/** The page's words, without the router's data or React's text markers. */
async function mainOf(response: Response): Promise<string> {
  const html = (await response.text()).replaceAll("<!-- -->", "");
  return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
}

/**
 * Alice owns "Friday" with Bob in it; Bob owns "Solo" alone. Both answered
 * Yes on 3 Nov, which the Reset froze into Friday's History, and both
 * answered again on 4 Nov. Bob has push on, a Display Name, an Invite to Solo
 * and a Password Reset Link from Alice.
 */
async function setUp() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
  const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
  await alice.post("/groups/new", { name: "Friday" });
  await bob.post("/groups/new", { name: "Solo" });
  const ids = { alice: await idOf("Alice"), bob: await idOf("Bob") };
  const friday = (await groupId("Friday"))!;
  const solo = (await groupId("Solo"))!;
  const invites = createInvites({ env, clock: app.clock });
  const invite = await invites.makeInvite(ids.alice, friday, "");
  if (!invite.ok) throw new Error("invite failed");
  await invites.joinWithInvite(ids.bob, invite.token);
  await invites.makeInvite(ids.bob, solo, "for Sam");

  await alice.post("/?index", { intent: "availability", availability: "yes" });
  await bob.post("/?index", { intent: "availability", availability: "yes" });
  app.clock.set(RESET_4_NOV);
  await app.runScheduled();
  app.clock.set("2026-11-04T12:00:00Z");
  await alice.post("/?index", { intent: "availability", availability: "maybe" });
  await bob.post("/?index", { intent: "availability", availability: "no" });

  await bob.subscribe(pushEndpoint("bob-phone"));
  await bob.post("/profile", { intent: "names", username: "Bob", displayName: "Bobby", colour: "sky" });
  await createResetLinks({ env, clock: app.clock }).make(ids.alice, ids.bob);
  return { app, alice, bob, ids, friday, solo };
}

async function count(table: string, where: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>();
  return row!.n;
}

describe("deleting a login", () => {
  it("erases the Member and everything of theirs; the other Member keeps their Group and History", async () => {
    const { app, alice, bob, ids, friday } = await setUp();
    const pushesBefore = app.push.sent.length;

    const response = await bob.post("/profile", { intent: "delete-login", password: PASSWORD });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login?notice=login-deleted");
    expect(bob.cookies.has("__Host-session")).toBe(false);
    const login = await mainOf(await bob.get("/login?notice=login-deleted"));
    expect(login).toContain("Your login was deleted.");

    expect(await count("members", "id = ?1", ids.bob)).toBe(0);
    for (const table of ["sessions", "push_subscriptions", "memberships", "checkins", "history_rows", "name_keys", "notification_prefs"]) {
      expect(await count(table, "member_id = ?1", ids.bob), table).toBe(0);
    }
    expect(await count("password_reset_links", "member_id = ?1 OR made_by = ?1", ids.bob)).toBe(0);
    expect(await groupId("Solo")).toBeNull();
    expect(await count("invites", "label = 'for Sam'")).toBe(0);
    expect(await count("login_failures", "kind = 'username' AND key = 'bob'")).toBe(0);

    // Alice keeps Friday, her Check-in and her History row; Bob is gone from all of it.
    expect(await groupId("Friday")).toBe(friday);
    expect(await count("checkins", "member_id = ?1", ids.alice)).toBe(2);
    expect(await count("history_rows", "member_id = ?1", ids.alice)).toBe(1);
    expect(await count("history_nights", "group_id = ?1", friday)).toBe(1);
    for (const page of ["/", `/groups/${friday}`, `/groups/${friday}/history`, `/groups/${friday}/history/2026-11-03`]) {
      const main = await mainOf(await alice.get(page));
      expect(main, page).not.toContain("Bobby");
      expect(main, page).not.toContain("@Bob");
    }
    expect(await mainOf(await alice.get(`/groups/${friday}`))).toContain("1 Member");

    // Nobody is notified.
    expect(app.push.sent.length).toBe(pushesBefore);
    // The deleted login cannot log in.
    expect((await app.device().post("/login", { username: "Bob", password: PASSWORD })).status).toBe(401);
  });

  it("frees the username and Display Name for a new login at once", async () => {
    const { app, bob } = await setUp();
    await bob.post("/profile", { intent: "delete-login", password: PASSWORD });

    const newBob = await app.createLogin({ username: "bob", password: "another fresh passphrase" });
    const carol = await app.createLogin({ username: "Carol", password: PASSWORD });
    const saved = await carol.post("/profile", { intent: "names", username: "Carol", displayName: "Bobby", colour: "sky" });
    expect(saved.headers.get("Location")).toBe("/profile?saved=1");
    expect((await newBob.get("/profile")).status).toBe(200);
  });

  it("refuses a wrong password, deletes nothing and counts it toward the login limits", async () => {
    const { app, bob, ids } = await setUp();
    const response = await bob.post("/profile", { intent: "delete-login", password: "not my password" });
    expect(response.status).toBe(400);
    const main = await mainOf(response);
    expect(main).toContain("That is not your password.");
    expect(main).not.toContain("not my password");
    expect(await count("members", "id = ?1", ids.bob)).toBe(1);
    expect(await groupId("Solo")).not.toBeNull();

    for (let i = 0; i < 4; i++) await bob.post("/profile", { intent: "delete-login", password: "not my password" });
    expect((await app.device().post("/login", { username: "Bob", password: PASSWORD })).status).toBe(401);
    const locked = await bob.post("/profile", { intent: "delete-login", password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await count("members", "id = ?1", ids.bob)).toBe(1);
  });

  it("refuses an Owner of a Group with others, lists it with a link, and deletes nothing", async () => {
    const { alice, ids, friday } = await setUp();
    const card = (await mainOf(await alice.get("/profile"))).split('id="delete-login-heading"')[1];
    expect(card).toContain("Make another Member Owner first");
    expect(card).toMatch(new RegExp(`<a class="list-tile-name"[^>]* href="/groups/${friday}"[^>]*>Friday</a>`));
    expect(card).not.toContain('name="password"');

    const response = await alice.post("/profile", { intent: "delete-login", password: PASSWORD });
    expect(response.status).toBe(409);
    expect(await mainOf(response)).toMatch(new RegExp(`href="/groups/${friday}"[^>]*>Friday</a>`));
    expect(await count("members", "id = ?1", ids.alice)).toBe(1);
    expect(await groupId("Friday")).toBe(friday);
  });

  it("offers the form once the Owner has handed the Group over", async () => {
    const { alice, ids, friday } = await setUp();
    await alice.post(`/groups/${friday}`, { intent: "hand-over", memberId: String(ids.bob), confirm: "yes" });
    const card = (await mainOf(await alice.get("/profile"))).split('id="delete-login-heading"')[1];
    expect(card).toContain('name="password"');
    expect(card).toMatch(/<button[^>]*class="btn-destructive"[^>]*>Delete login<\/button>/);
    expect((await alice.post("/profile", { intent: "delete-login", password: PASSWORD })).status).toBe(302);
    expect(await groupId("Friday")).toBe(friday);
    expect(await count("groups", "owner_id = ?1", ids.bob)).toBe(2);
  });
});

describe("the delete batch", () => {
  it("runs with foreign keys enforced: a Member who owns a Group cannot be deleted directly", async () => {
    const { ids } = await setUp();
    await expect(env.DB.prepare("DELETE FROM members WHERE id = ?1").bind(ids.alice).run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("rolls back when the Group gains a Member between the check and the batch", async () => {
    const { app, ids, solo } = await setUp();
    await app.createLogin({ username: "Carol", password: PASSWORD });
    const carolId = await idOf("Carol");
    // Carol joins Solo just before the delete batch runs, after the check
    // found Bob alone in it. The delete batch is the one with a DELETE FROM
    // members; the login limits' batches run untouched.
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const sql = statements.map((statement) => JSON.stringify(statement)).join(" ");
            if (!raced && statements.length === 3 && sql.includes("DELETE FROM members")) {
              raced = true;
              await target
                .prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, ?3)")
                .bind(solo, carolId, "2026-11-04T12:00:00.000Z")
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const auth = createAuth({ env: { ...env, DB: racingDb }, clock: app.clock });
    const member = { id: ids.bob, username: "Bob", displayName: "Bobby", colour: "sky" as const, passwordWasReset: false };
    expect(await auth.deleteLogin(member, PASSWORD, "198.51.100.7")).toEqual({
      ok: false,
      reason: "owns-groups",
      groups: [{ groupId: solo, name: "Solo" }],
    });
    expect(raced).toBe(true);
    expect(await count("members", "id = ?1", ids.bob)).toBe(1);
    expect(await groupId("Solo")).toBe(solo);
    expect(await count("sessions", "member_id = ?1", ids.bob)).toBeGreaterThan(0);
  });
});
