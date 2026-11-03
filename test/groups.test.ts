import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { groupNameError, normaliseGroupName } from "~/groups";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

/** The page body, with React's text-node markers dropped. */
function bodyOf(html: string): string {
  return html.slice(html.indexOf("<body"), html.indexOf("</body>")).replaceAll("<!-- -->", "");
}

interface GroupRow {
  id: number;
  name: string;
  owner_id: number;
  threshold: number;
  created_at: string;
}

async function groups(): Promise<GroupRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM groups ORDER BY id").all<GroupRow>();
  return results;
}

async function memberships(): Promise<{ group_id: number; member_id: number; joined_at: string }[]> {
  const { results } = await env.DB.prepare("SELECT * FROM memberships ORDER BY group_id, member_id").all<{
    group_id: number;
    member_id: number;
    joined_at: string;
  }>();
  return results;
}

async function memberId(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  return row!.id;
}

describe("migration 0003", () => {
  it("adds groups, memberships, checkins and group_night_state", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('groups', 'memberships', 'checkins', 'group_night_state') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual(["checkins", "group_night_state", "groups", "memberships"]);
  });

  it("refuses an Availability other than yes, maybe or no", async () => {
    const app = startApp();
    await app.createLogin({ username: "Alice", password: PASSWORD });
    const insert = env.DB.prepare(
      "INSERT INTO checkins (member_id, game_night, availability, updated_at) VALUES (?1, '2026-11-03', ?2, '2026-11-03T12:00:00.000Z')",
    );
    const id = await memberId("Alice");
    await expect(insert.bind(id, "later").run()).rejects.toThrow(/CHECK/);
    await expect(insert.bind(id, "yes").run()).resolves.toBeDefined();
  });
});

describe("Group name rule", () => {
  it.each([
    ["", "Use 1 to 40 characters."],
    ["   ", "Use 1 to 40 characters."],
    ["x".repeat(41), "Use 1 to 40 characters."],
    ["🎲".repeat(41), "Use 1 to 40 characters."],
    ["Board\tgames", "Remove tabs, line breaks and invisible characters."],
    ["Zero​width", "Remove tabs, line breaks and invisible characters."],
  ])("refuses %j", (raw, message) => {
    expect(groupNameError(normaliseGroupName(raw))).toBe(message);
  });

  it.each([["A"], ["x".repeat(40)], ["🎲".repeat(40)], ["Friday Night 🎮"]])("accepts %j", (raw) => {
    expect(groupNameError(normaliseGroupName(raw))).toBeNull();
  });

  it("trims and NFC-normalises the name", () => {
    expect(normaliseGroupName("  Café  ")).toBe("Café");
  });
});

describe("Create a Group", () => {
  it("sends a logged-out visitor to the login", async () => {
    const response = await startApp().fetch("/groups/new");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });

  it("shows the name field, the Owner line and Create Group with a way back", async () => {
    const browser = await startApp().createLogin({ username: "Alice", password: PASSWORD });
    const response = await browser.get("/groups/new");
    const html = await response.text();
    const body = bodyOf(html);

    expect(response.status).toBe(200);
    expect(html).not.toMatch(/\sstyle=/);
    expect(body).toContain("Create a Group</h1>");
    expect(body).toMatch(/<label[^>]*for="name"[^>]*>Group name<\/label>/);
    expect(body).toMatch(/<input[^>]*id="name"[^>]*aria-describedby="name-help"/);
    expect(body).toContain("You become the Owner. The Group is Game On when 3 people say Yes.");
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*>Create Group<\/button>/);
    expect(body).toMatch(/<a[^>]*href="\/"[^>]*>/);
    expect(body).not.toContain("Error: ");
  });

  it.each([[""], ["x".repeat(41)]])("refuses %j with a field error and keeps the typed name", async (name) => {
    const browser = await startApp().createLogin({ username: "Alice", password: PASSWORD });
    const response = await browser.post("/groups/new", { name });
    const body = bodyOf(await response.text());

    expect(response.status).toBe(400);
    const input = body.match(/<input[^>]*id="name"[^>]*>/)![0];
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="name-help"');
    expect(input).toContain(`value="${name}"`);
    expect(body).toMatch(/<p id="name-help" class="field-error">Error: Use 1 to 40 characters.<\/p>/);
    expect(await groups()).toEqual([]);
  });

  it("creates a Group with the creator as Owner, a threshold of 3 and one membership", async () => {
    const app = startApp();
    const browser = await app.createLogin({ username: "Alice", password: PASSWORD });
    const name = "x".repeat(40);
    const response = await browser.post("/groups/new", { name, owner_id: "999", threshold: "1" });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    const alice = await memberId("Alice");
    const [group] = await groups();
    expect(group).toMatchObject({ name, owner_id: alice, threshold: 3, created_at: "2026-11-03T12:00:00.000Z" });
    expect(await memberships()).toEqual([
      { group_id: group.id, member_id: alice, joined_at: "2026-11-03T12:00:00.000Z" },
    ]);
  });

  it("accepts an emoji name and lets two Groups share a name", async () => {
    const browser = await startApp().createLogin({ username: "Alice", password: PASSWORD });
    await browser.post("/groups/new", { name: " Game Night 🎲 " });
    await browser.post("/groups/new", { name: "Game Night 🎲" });

    const rows = await groups();
    expect(rows.map((row) => row.name)).toEqual(["Game Night 🎲", "Game Night 🎲"]);
    expect(await memberships()).toHaveLength(2);
  });

  it("refuses a POST without a same-origin Origin", async () => {
    const browser = await startApp().createLogin({ username: "Alice", password: PASSWORD });
    const response = await browser.post("/groups/new", { name: "Sneaky" }, { origin: "https://evil.test" });

    expect(response.status).toBe(403);
    expect(await groups()).toEqual([]);
  });

  it("links the empty Tonight's Create a Group to the new Group screen", async () => {
    const browser = await startApp().createLogin({ username: "Alice", password: PASSWORD });
    const body = bodyOf(await (await browser.get("/")).text());

    expect(body).toMatch(/<a[^>]*class="btn-primary"[^>]*href="\/groups\/new"[^>]*>Create a Group<\/a>|<a[^>]*href="\/groups\/new"[^>]*class="btn-primary"[^>]*>Create a Group<\/a>/);
    expect(body).not.toMatch(/<button[^>]*>Create a Group<\/button>/);
  });
});
