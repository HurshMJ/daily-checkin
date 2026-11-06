import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { allowGroupsSql } from "~/group-creators-sql";
import { createGroups } from "~/groups";
import { createInvites } from "~/invites";

import deployYml from "../.github/workflows/deploy.yml?raw";
import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

/** The page body, with React's text-node markers dropped. */
function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

async function count(sql: string, ...values: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...values).first<{ n: number }>();
  return row!.n;
}

async function idOf(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  return row!.id;
}

/** Every Member's right to create Groups, by username. */
async function rights(): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare("SELECT username, can_create_groups FROM members ORDER BY id").all<{
    username: string;
    can_create_groups: number;
  }>();
  return Object.fromEntries(results.map((row) => [row.username, row.can_create_groups]));
}

const rowCounts = async () => ({
  groups: await count("SELECT COUNT(*) AS n FROM groups"),
  memberships: await count("SELECT COUNT(*) AS n FROM memberships"),
});

describe("migration 0012", () => {
  it("starts every new login without the right, from a Setup Link or an Invite", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    await alice.post("/groups/new", { name: "Friday" });
    await app.createLogin({ username: "Bob", password: PASSWORD });
    const made = await createInvites({ env, clock: app.clock }).makeInvite(
      await idOf("Alice"),
      (await env.DB.prepare("SELECT id FROM groups").first<{ id: number }>())!.id,
      "",
    );
    if (!made.ok) throw new Error("make failed");
    const carol = await app.deviceWithLink(`/invite/${made.token}`);
    const joined = await carol.post("/invite", { intent: "create", username: "Carol", password: PASSWORD, colour: "sky" });
    expect(joined.status).toBe(302);

    expect(await rights()).toEqual({ Alice: 1, Bob: 0, Carol: 0 });
  });

  it("gives the right to every Member who owns a Group when it runs, and to no one else", async () => {
    const all = env.TEST_MIGRATIONS;
    const at = all.findIndex((migration) => migration.name.startsWith("0012_"));
    expect(at).toBeGreaterThan(0);
    await reset();
    await applyD1Migrations(env.DB, all.slice(0, at));

    const member = (id: number, username: string) =>
      env.DB.prepare(
        `INSERT INTO members (id, username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
         VALUES (?1, ?2, lower(?2), 'blue', 'aa', 'bb', 1, '2026-11-01T00:00:00.000Z')`,
      ).bind(id, username);
    const group = (id: number, ownerId: number) =>
      env.DB.prepare("INSERT INTO groups (id, name, owner_id, threshold, created_at) VALUES (?1, 'G', ?2, 3, '2026-11-01T00:00:00.000Z')").bind(
        id,
        ownerId,
      );
    const membership = (groupId: number, memberId: number) =>
      env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, '2026-11-01T00:00:00.000Z')").bind(
        groupId,
        memberId,
      );
    await env.DB.batch([
      member(1, "Alice"),
      member(2, "Bob"),
      member(3, "Carol"),
      member(4, "Dave"),
      // Alice owns two Groups; Dave was handed his; Bob is a Member only.
      group(1, 1),
      group(2, 1),
      group(3, 4),
      membership(1, 1),
      membership(1, 2),
      membership(2, 1),
      membership(3, 4),
      membership(3, 1),
    ]);

    await applyD1Migrations(env.DB, all);

    expect(await rights()).toEqual({ Alice: 1, Bob: 0, Carol: 0, Dave: 1 });
  });

  it("refuses any value but 0 and 1", async () => {
    await startApp().createLogin({ username: "Alice", password: PASSWORD });
    for (const bad of [2, -1, null]) {
      await expect(env.DB.prepare("UPDATE members SET can_create_groups = ?1").bind(bad).run(), String(bad)).rejects.toThrow();
    }
    expect(await rights()).toEqual({ Alice: 0 });
  });
});

describe("the Operator's allow-groups statement", () => {
  async function run(usernameKey: string, allowed: boolean) {
    return (await env.DB.prepare(allowGroupsSql(usernameKey, allowed)).all()).results;
  }

  it("gives and takes away the right of only the named login, and names it", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD });
    await app.createLogin({ username: "O'Brien", password: PASSWORD });

    expect(await run("o'brien", true)).toEqual([{ username: "O'Brien", canCreateGroups: 1 }]);
    expect(await rights()).toEqual({ Alice: 0, "O'Brien": 1 });

    expect(await run("o'brien", false)).toEqual([{ username: "O'Brien", canCreateGroups: 0 }]);
    expect(await rights()).toEqual({ Alice: 0, "O'Brien": 0 });
  });

  it("changes no row for an unknown username key", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD });

    expect(await run("bob", true)).toEqual([]);
    expect(await run("alice' OR 1=1 --", true)).toEqual([]);
    expect(await rights()).toEqual({ Alice: 0 });
  });
});

describe("a Member without the right to create Groups", () => {
  async function setUp() {
    const app = startApp();
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    return { app, bob };
  }

  it("sees no Create a Group on the empty Tonight, and is told to ask a Group's Owner for an Invite", async () => {
    const { bob } = await setUp();
    const body = bodyOf(await (await bob.get("/")).text());

    expect(body).toContain("You&#x27;re not in a Group yet");
    expect(body).toContain("Ask a Group&#x27;s Owner for an Invite, then open the Invite link they send you.");
    expect(body).not.toContain('href="/groups/new"');
    expect(body).not.toContain("Create a Group");
  });

  it("gets the not available page, with no form, on GET /groups/new", async () => {
    const { bob } = await setUp();
    const response = await bob.get("/groups/new");
    const body = bodyOf(await response.text());

    expect(response.status).toBe(200);
    expect(body).toContain("Creating a Group is not available");
    expect(body).toContain("Ask a Group&#x27;s Owner for an Invite, then open the Invite link they send you.");
    expect(body).toMatch(/<a[^>]*href="\/"[^>]*>Back to Tonight<\/a>/);
    expect(body).not.toContain("<form");
    expect(body).not.toContain('name="name"');
  });

  it("is refused with 403 on POST /groups/new, whatever the name, and nothing is written", async () => {
    const { bob } = await setUp();
    for (const name of ["Sneaky", "", "x".repeat(41)]) {
      const response = await bob.post("/groups/new", { name });
      expect(response.status, name).toBe(403);
      expect(bodyOf(await response.text()), name).toContain("Creating a Group is not available");
    }
    expect(await rowCounts()).toEqual({ groups: 0, memberships: 0 });
  });

  it("is refused when the right is taken away after the page loaded", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    expect(bodyOf(await (await alice.get("/groups/new")).text())).toContain('name="name"');

    await app.allowGroups("Alice", false);
    const response = await alice.post("/groups/new", { name: "Friday" });

    expect(response.status).toBe(403);
    expect(await rowCounts()).toEqual({ groups: 0, memberships: 0 });
  });

  it("does not get the right by being handed a Group", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
    await alice.post("/groups/new", { name: "Friday" });
    const groups = createGroups({ env, clock: app.clock });
    const [friday] = await groups.membershipsFor(await idOf("Alice"));
    const invites = createInvites({ env, clock: app.clock });
    const made = await invites.makeInvite(await idOf("Alice"), friday.groupId, "");
    if (!made.ok) throw new Error("make failed");
    await invites.joinWithInvite(await idOf("Bob"), made.token);

    expect((await groups.handOver(await idOf("Alice"), friday.groupId, await idOf("Bob"))).ok).toBe(true);

    expect(await rights()).toEqual({ Alice: 1, Bob: 0 });
    expect((await bob.post("/groups/new", { name: "Mine" })).status).toBe(403);
  });
});

describe("a Member with the right to create Groups", () => {
  it("is offered Create a Group, creates one and becomes its Owner", async () => {
    const app = startApp();
    const alice = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    expect(bodyOf(await (await alice.get("/")).text())).toMatch(/<a[^>]*href="\/groups\/new"[^>]*>Create a Group<\/a>/);

    const response = await alice.post("/groups/new", { name: "Friday" });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(await count("SELECT COUNT(*) AS n FROM groups WHERE owner_id = ?1", await idOf("Alice"))).toBe(1);
  });
});

describe("createGroup", () => {
  it("writes no row, and no membership into an earlier Group, when it refuses right after a create", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    await app.createLogin({ username: "Bob", password: PASSWORD });
    const groups = createGroups({ env, clock: app.clock });

    const created = await groups.createGroup(await idOf("Alice"), "Friday");
    expect(created.ok).toBe(true);
    const refused = await groups.createGroup(await idOf("Bob"), "Sneaky");

    expect(refused).toEqual({ ok: false, reason: "not-allowed" });
    expect(await rowCounts()).toEqual({ groups: 1, memberships: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM memberships WHERE member_id = ?1", await idOf("Bob"))).toBe(0);
  });

  it("still names an invalid name for a Member with the right", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });

    const result = await createGroups({ env, clock: app.clock }).createGroup(await idOf("Alice"), " ");

    expect(result).toMatchObject({ ok: false, reason: "invalid", name: "" });
    expect(await rowCounts()).toEqual({ groups: 0, memberships: 0 });
  });
});

describe("the deploy smoke check", () => {
  it("greps for text both empty Tonight views show", async () => {
    const marker = /grep -q "([^"]+)" "\$body"/.exec(deployYml)?.[1];
    expect(marker).toBeDefined();

    const app = startApp();
    const allowed = await app.createLogin({ username: "Alice", password: PASSWORD, canCreateGroups: true });
    const notAllowed = await app.createLogin({ username: "Bob", password: PASSWORD });

    expect(await (await allowed.get("/")).text()).toContain(marker);
    expect(await (await notAllowed.get("/")).text()).toContain(marker);
  });
});
