import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createCheckins } from "~/checkins";
import { createGroups, groupNameError, MAX_THRESHOLD, normaliseGroupName, thresholdError } from "~/groups";
import { createInvites } from "~/invites";

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

describe("threshold rule", () => {
  it.each([["1"], ["2"], ["42"], [String(MAX_THRESHOLD)]])("accepts %j", (raw) => {
    expect(thresholdError(raw)).toBeNull();
  });

  // A threshold is posted by the stepper as plain digits, so anything else is refused, spaces included.
  it.each([["0"], ["100"], ["2.5"], ["-1"], ["+3"], [""], [" 3"], ["3 "], ["03"], ["1e1"], ["three"]])("refuses %j", (raw) => {
    expect(thresholdError(raw)).toBe("Use a whole number from 1 to 99.");
  });
});

/**
 * Alice owns "Friday" with Bob and Carol in it; Dave is in no Group. Each
 * name maps to the Member's id.
 */
async function lifecycle() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
  for (const username of ["Bob", "Carol", "Dave"]) await app.createLogin({ username, password: PASSWORD });
  await alice.post("/groups/new", { name: "Friday" });
  const ids = {
    alice: await memberId("Alice"),
    bob: await memberId("Bob"),
    carol: await memberId("Carol"),
    dave: await memberId("Dave"),
  };
  const [{ id: friday }] = await groups();
  await env.DB.batch(
    [ids.bob, ids.carol].map((id) =>
      env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, ?3)").bind(
        friday,
        id,
        "2026-11-03T12:00:00.000Z",
      ),
    ),
  );
  const services = { env, clock: app.clock };
  return { app, ids, friday, groupsOf: createGroups(services), checkins: createCheckins(services) };
}

async function memberIdsOf(groupId: number): Promise<number[]> {
  const { results } = await env.DB.prepare("SELECT member_id FROM memberships WHERE group_id = ?1 ORDER BY member_id")
    .bind(groupId)
    .all<{ member_id: number }>();
  return results.map((row) => row.member_id);
}

async function groupRow(groupId: number): Promise<GroupRow | null> {
  return env.DB.prepare("SELECT * FROM groups WHERE id = ?1").bind(groupId).first<GroupRow>();
}

describe("renaming a Group", () => {
  it("lets the Owner rename it with the Group name rule", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.rename(ids.alice, friday, "  Saturday 🎲 ")).toEqual({ ok: true });
    expect((await groupRow(friday))?.name).toBe("Saturday 🎲");
    expect(await groupsOf.rename(ids.alice, friday, "x".repeat(41))).toEqual({
      ok: false,
      reason: "invalid",
      error: "Use 1 to 40 characters.",
    });
    expect((await groupRow(friday))?.name).toBe("Saturday 🎲");
  });

  it("refuses a Member who is not the Owner and anyone outside the Group", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.rename(ids.bob, friday, "Mine")).toEqual({ ok: false, reason: "not-owner" });
    expect(await groupsOf.rename(ids.dave, friday, "Mine")).toEqual({ ok: false, reason: "not-member" });
    expect(await groupsOf.rename(ids.alice, friday + 100, "Mine")).toEqual({ ok: false, reason: "not-member" });
    expect((await groupRow(friday))?.name).toBe("Friday");
  });
});

describe("setting the Game On Threshold", () => {
  it("accepts 1 and 99 and refuses anything else, changing nothing", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.setThreshold(ids.alice, friday, "1")).toEqual({ ok: true });
    expect((await groupRow(friday))?.threshold).toBe(1);
    expect(await groupsOf.setThreshold(ids.alice, friday, "99")).toEqual({ ok: true });
    expect((await groupRow(friday))?.threshold).toBe(99);
    for (const raw of ["0", "100", "2.5", "-1", "", " 3"]) {
      expect(await groupsOf.setThreshold(ids.alice, friday, raw), raw).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect((await groupRow(friday))?.threshold).toBe(99);
  });

  it("refuses a non-Owner and a non-Member", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.setThreshold(ids.bob, friday, "1")).toEqual({ ok: false, reason: "not-owner" });
    expect(await groupsOf.setThreshold(ids.dave, friday, "1")).toEqual({ ok: false, reason: "not-member" });
    expect((await groupRow(friday))?.threshold).toBe(3);
  });
});

describe("Make Owner", () => {
  it("hands the Group to another Member and leaves pending Invites alone", async () => {
    const { app, ids, friday, groupsOf } = await lifecycle();
    const invites = createInvites({ env, clock: app.clock });
    const made = await invites.makeInvite(ids.alice, friday, "for Sam");
    if (!made.ok) throw new Error("make failed");

    expect(await groupsOf.handOver(ids.alice, friday, ids.bob)).toEqual({ ok: true });
    expect((await groupRow(friday))?.owner_id).toBe(ids.bob);
    expect((await invites.pendingInvites(ids.bob, friday))?.map((invite) => invite.label)).toEqual(["for Sam"]);
    expect(await memberIdsOf(friday)).toEqual([ids.alice, ids.bob, ids.carol]);
    expect(await invites.joinWithInvite(ids.dave, made.token)).toBe("joined");
  });

  it("refuses a handover to the Owner themself or to a non-Member", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    const refused = { ok: false, reason: "invalid", error: "Choose another Member of the Group." };
    expect(await groupsOf.handOver(ids.alice, friday, ids.alice)).toEqual(refused);
    expect(await groupsOf.handOver(ids.alice, friday, ids.dave)).toEqual(refused);
    expect((await groupRow(friday))?.owner_id).toBe(ids.alice);
  });

  it("makes the old Owner's next change a no-op once they have handed over", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    await groupsOf.handOver(ids.alice, friday, ids.bob);
    expect(await groupsOf.remove(ids.alice, friday, ids.bob)).toEqual({ ok: false, reason: "not-owner" });
    expect(await groupsOf.handOver(ids.alice, friday, ids.carol)).toEqual({ ok: false, reason: "not-owner" });
    expect(await memberIdsOf(friday)).toEqual([ids.alice, ids.bob, ids.carol]);
    expect((await groupRow(friday))?.owner_id).toBe(ids.bob);
  });
});

describe("removing a Member", () => {
  it("lets the Owner remove any other Member, keeping their Check-ins", async () => {
    const { ids, friday, groupsOf, checkins } = await lifecycle();
    await checkins.setAvailability(ids.bob, friday, "yes");
    expect(await groupsOf.remove(ids.alice, friday, ids.bob)).toEqual({ ok: true });
    expect(await memberIdsOf(friday)).toEqual([ids.alice, ids.carol]);
    expect((await checkins.tonightFor(ids.bob)).boards).toEqual([]);
    const kept = await env.DB.prepare("SELECT availability FROM group_checkins WHERE group_id = ?1 AND member_id = ?2")
      .bind(friday, ids.bob)
      .first();
    expect(kept).toEqual({ availability: "yes" });
  });

  it("refuses removing the Owner, a non-Member, and any non-Owner's remove", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.remove(ids.alice, friday, ids.alice)).toEqual({
      ok: false,
      reason: "invalid",
      error: "The Owner cannot be removed. Make another Member Owner first.",
    });
    expect(await groupsOf.remove(ids.alice, friday, ids.dave)).toEqual({
      ok: false,
      reason: "invalid",
      error: "That person is not in this Group.",
    });
    expect(await groupsOf.remove(ids.bob, friday, ids.carol)).toEqual({ ok: false, reason: "not-owner" });
    expect(await groupsOf.remove(ids.bob, friday, ids.alice)).toEqual({ ok: false, reason: "not-owner" });
    expect(await groupsOf.remove(ids.dave, friday, ids.carol)).toEqual({ ok: false, reason: "not-member" });
    expect(await memberIdsOf(friday)).toEqual([ids.alice, ids.bob, ids.carol]);
  });
});

describe("leaving a Group", () => {
  it("lets a Member leave, and the Board drops off their Tonight", async () => {
    const { ids, friday, groupsOf, checkins } = await lifecycle();
    expect(await groupsOf.leave(ids.bob, friday)).toEqual({ ok: true, deleted: false });
    expect(await memberIdsOf(friday)).toEqual([ids.alice, ids.carol]);
    expect((await checkins.tonightFor(ids.bob)).boards).toEqual([]);
    expect(await groupsOf.leave(ids.bob, friday)).toEqual({ ok: false, reason: "not-member" });
  });

  it("refuses the Owner while other Members remain", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.leave(ids.alice, friday)).toEqual({ ok: false, reason: "owner-must-hand-over" });
    expect(await memberIdsOf(friday)).toEqual([ids.alice, ids.bob, ids.carol]);
  });

  it("deletes the Group when its Owner is the last Member, with its Invites, night state and Check-ins", async () => {
    const { app, ids, friday, groupsOf, checkins } = await lifecycle();
    await createInvites({ env, clock: app.clock }).makeInvite(ids.alice, friday, "");
    await groupsOf.setThreshold(ids.alice, friday, "1");
    await checkins.setAvailability(ids.alice, friday, "yes");
    await checkins.setAvailability(ids.bob, friday, "yes");
    await groupsOf.leave(ids.bob, friday);
    await groupsOf.leave(ids.carol, friday);

    expect(await groupsOf.leave(ids.alice, friday)).toEqual({ ok: true, deleted: true });
    expect(await groupRow(friday)).toBeNull();
    await expectNoRowsOf(friday);
  });
});

/** D1 enforces ON DELETE CASCADE: a deleted Group leaves no memberships, Invites, night state or Check-ins. */
async function expectNoRowsOf(groupId: number) {
  for (const table of ["memberships", "invites", "group_night_state", "group_checkins"]) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?1`).bind(groupId).first<{
      n: number;
    }>();
    expect(row?.n, table).toBe(0);
  }
}

describe("deleting a Group", () => {
  it("deletes the Group for everyone with no orphan rows, its Check-ins included", async () => {
    const { app, ids, friday, groupsOf, checkins } = await lifecycle();
    await createInvites({ env, clock: app.clock }).makeInvite(ids.alice, friday, "");
    await groupsOf.setThreshold(ids.alice, friday, "1");
    await checkins.setAvailability(ids.carol, friday, "yes");
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_night_state WHERE group_id = ?1")
      .bind(friday)
      .first<{ n: number }>();
    expect(before?.n).toBe(1);

    expect(await groupsOf.deleteGroup(ids.alice, friday)).toEqual({ ok: true });
    expect(await groupRow(friday)).toBeNull();
    await expectNoRowsOf(friday);
    expect((await checkins.tonightFor(ids.carol)).boards).toEqual([]);
  });

  it("refuses a non-Owner and a non-Member", async () => {
    const { ids, friday, groupsOf } = await lifecycle();
    expect(await groupsOf.deleteGroup(ids.bob, friday)).toEqual({ ok: false, reason: "not-owner" });
    expect(await groupsOf.deleteGroup(ids.dave, friday)).toEqual({ ok: false, reason: "not-member" });
    expect(await groupRow(friday)).not.toBeNull();
  });
});

describe("Game On after a Group change", () => {
  async function pill(checkins: ReturnType<typeof createCheckins>, memberId: number) {
    return (await checkins.tonightFor(memberId)).boards[0].pill.text;
  }

  it("turns Game On when the threshold is lowered to the Yes count", async () => {
    const { ids, friday, groupsOf, checkins } = await lifecycle();
    await checkins.setAvailability(ids.alice, friday, "yes");
    await checkins.setAvailability(ids.bob, friday, "yes");
    expect(await pill(checkins, ids.alice)).toBe("Needs 1 more Yes");
    await groupsOf.setThreshold(ids.alice, friday, "2");
    expect(await pill(checkins, ids.alice)).toBe("Game On");
    // The mark was written, not only computed: raising the threshold back reads Game Off.
    await groupsOf.setThreshold(ids.alice, friday, "3");
    expect(await pill(checkins, ids.alice)).toBe("Game Off");
  });

  it("reads Game Off when a Yes Member is removed or leaves after Game On", async () => {
    const { ids, friday, groupsOf, checkins } = await lifecycle();
    for (const id of [ids.alice, ids.bob, ids.carol]) await checkins.setAvailability(id, friday, "yes");
    expect(await pill(checkins, ids.alice)).toBe("Game On");

    await groupsOf.remove(ids.alice, friday, ids.bob);
    expect(await pill(checkins, ids.alice)).toBe("Game Off");
    await groupsOf.setThreshold(ids.alice, friday, "2");
    expect(await pill(checkins, ids.alice)).toBe("Game On");
    await groupsOf.leave(ids.carol, friday);
    expect(await pill(checkins, ids.alice)).toBe("Game Off");
  });

  it("reads Game Off when the threshold is raised above the Yes count after Game On", async () => {
    const { ids, friday, groupsOf, checkins } = await lifecycle();
    for (const id of [ids.alice, ids.bob, ids.carol]) await checkins.setAvailability(id, friday, "yes");
    await groupsOf.setThreshold(ids.alice, friday, "4");
    expect(await pill(checkins, ids.alice)).toBe("Game Off");
  });

  it("reads Needs N more Yes after a drop before any Game On", async () => {
    const { ids, friday, groupsOf, checkins } = await lifecycle();
    await checkins.setAvailability(ids.alice, friday, "yes");
    await checkins.setAvailability(ids.bob, friday, "yes");
    await groupsOf.remove(ids.alice, friday, ids.bob);
    expect(await pill(checkins, ids.alice)).toBe("Needs 2 more Yes");
    await groupsOf.setThreshold(ids.alice, friday, "5");
    expect(await pill(checkins, ids.alice)).toBe("Needs 4 more Yes");
  });
});
