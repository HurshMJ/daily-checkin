import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createCheckins, type Availability } from "~/checkins";
import { createGroups } from "~/groups";
import { createHistory, MAX_NIGHTS_PER_RESET, nightsToFreeze } from "~/history";
import { createInvites } from "~/invites";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

/** 06:00 UTC+4 on 4 Nov 2026: the Reset that ends Game Night 2026-11-03. */
const RESET_4_NOV = "2026-11-04T02:00:00.000Z";

async function memberId(username: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE username = ?1").bind(username).first<{ id: number }>();
  return row!.id;
}

/** Every frozen night as "Group night threshold state", oldest first. */
async function frozenNights(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.name, h.game_night, h.threshold, h.final_state FROM history_nights h JOIN groups g ON g.id = h.group_id
     ORDER BY h.game_night, g.name`,
  ).all<{ name: string; game_night: string; threshold: number; final_state: string }>();
  return results.map((row) => `${row.name} ${row.game_night} ${row.threshold} ${row.final_state}`);
}

/** Every History row as "Group night username availability note", in a stable order. */
async function frozenRows(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.name, h.game_night, p.username, r.availability, r.note
     FROM history_rows r JOIN history_nights h ON h.id = r.night_id
     JOIN groups g ON g.id = h.group_id JOIN members p ON p.id = r.member_id
     ORDER BY h.game_night, g.name, p.username`,
  ).all<{ name: string; game_night: string; username: string; availability: string | null; note: string | null }>();
  return results.map((row) =>
    [row.name, row.game_night, row.username, row.availability ?? "-", row.note ?? "-"].join(" "),
  );
}

async function storedNight(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT last_reset_game_night AS night FROM scheduler_state WHERE id = 1").first<{
    night: string | null;
  }>();
  return row?.night ?? null;
}

/**
 * Alice owns "Friday" and Bob joined it through an Invite; Carol owns "Solo"
 * alone. Everything happens at `now`, 3 Nov 2026 by default.
 */
async function setUp(now = "2026-11-03T12:00:00Z") {
  const app = startApp({ now });
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD, colour: "violet" });
  await app.createLogin({ username: "Bob", password: PASSWORD });
  await app.createLogin({ username: "Carol", password: PASSWORD });
  const ids = { alice: await memberId("Alice"), bob: await memberId("Bob"), carol: await memberId("Carol") };
  const groups = createGroups({ env, clock: app.clock });
  const friday = await groups.createGroup(ids.alice, "Friday");
  const solo = await groups.createGroup(ids.carol, "Solo");
  if (!friday.ok || !solo.ok) throw new Error("createGroup failed");
  const invites = createInvites({ env, clock: app.clock });
  const made = await invites.makeInvite(ids.alice, friday.groupId, "");
  if (!made.ok) throw new Error("makeInvite failed");
  await invites.joinWithInvite(ids.bob, made.token);
  const checkins = createCheckins({ env, clock: app.clock });
  const answer = (who: number, availability: Availability, group = who === ids.carol ? solo.groupId : friday.groupId) =>
    checkins.setAvailability(who, group, availability);
  return { app, alice, ids, groups, invites, checkins, answer, friday: friday.groupId, solo: solo.groupId };
}

describe("nightsToFreeze", () => {
  it("freezes only the night just ended when no Reset has ever run", () => {
    expect(nightsToFreeze(null, "2026-11-04")).toEqual(["2026-11-03"]);
  });

  it("freezes nothing when the stored night is current", () => {
    expect(nightsToFreeze("2026-11-04", "2026-11-04")).toEqual([]);
    expect(nightsToFreeze("2026-11-05", "2026-11-04")).toEqual([]);
  });

  it("freezes every missed night oldest first, across a month end, at most 30", () => {
    expect(nightsToFreeze("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"]);
    const many = nightsToFreeze("2026-01-01", "2026-11-04");
    expect(many).toHaveLength(MAX_NIGHTS_PER_RESET);
    expect(many[0]).toBe("2026-01-01");
    expect(many.at(-1)).toBe("2026-01-30");
  });
});

describe("the Reset", () => {
  it("freezes the night just ended for every Group, with a row per Member, answered or not", async () => {
    const { app, ids, answer, checkins, friday } = await setUp();
    await answer(ids.alice, "yes");
    await checkins.setNote(ids.alice, friday, "bringing snacks");
    await answer(ids.bob, "maybe");

    app.clock.set(RESET_4_NOV);
    await app.runScheduled();

    expect(await frozenNights()).toEqual(["Friday 2026-11-03 3 never", "Solo 2026-11-03 3 never"]);
    expect(await frozenRows()).toEqual([
      "Friday 2026-11-03 Alice yes bringing snacks",
      "Friday 2026-11-03 Bob maybe -",
      "Solo 2026-11-03 Carol - -",
    ]);
    expect(await storedNight()).toBe("2026-11-04");
  });

  it("freezes each Group's own answers, Notes and final state", async () => {
    const { app, ids, answer, checkins, groups, invites, friday } = await setUp();
    const sunday = await groups.createGroup(ids.alice, "Sunday");
    if (!sunday.ok) throw new Error("createGroup failed");
    const made = await invites.makeInvite(ids.alice, sunday.groupId, "");
    if (!made.ok) throw new Error("makeInvite failed");
    await invites.joinWithInvite(ids.bob, made.token);
    await groups.setThreshold(ids.alice, friday, "2");
    await groups.setThreshold(ids.alice, sunday.groupId, "2");
    await answer(ids.alice, "yes");
    await answer(ids.bob, "yes");
    await answer(ids.alice, "no", sunday.groupId);
    await checkins.setNote(ids.alice, sunday.groupId, "away");
    await answer(ids.bob, "yes", sunday.groupId);

    app.clock.set(RESET_4_NOV);
    await app.runScheduled();

    expect(await frozenNights()).toEqual([
      "Friday 2026-11-03 2 on",
      "Solo 2026-11-03 3 never",
      "Sunday 2026-11-03 2 never",
    ]);
    expect(await frozenRows()).toEqual([
      "Friday 2026-11-03 Alice yes -",
      "Friday 2026-11-03 Bob yes -",
      "Solo 2026-11-03 Carol - -",
      "Sunday 2026-11-03 Alice no away",
      "Sunday 2026-11-03 Bob yes -",
    ]);
  });

  it("freezes Game On, Game Off and Never on with the threshold in force", async () => {
    const { app, ids, answer, groups, friday, solo } = await setUp();
    // Friday reaches Game On at 2 Yes and stays there.
    expect(await groups.setThreshold(ids.alice, friday, "2")).toEqual({ ok: true });
    await answer(ids.alice, "yes");
    await answer(ids.bob, "yes");
    // Solo reaches Game On at 1 Yes, then Carol changes to No: Game Off.
    expect(await groups.setThreshold(ids.carol, solo, "1")).toEqual({ ok: true });
    await answer(ids.carol, "yes");
    await answer(ids.carol, "no");

    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    expect(await frozenNights()).toEqual(["Friday 2026-11-03 2 on", "Solo 2026-11-03 1 off"]);

    // A later threshold change does not alter the past night.
    app.clock.set("2026-11-04T10:00:00Z");
    expect(await groups.setThreshold(ids.alice, friday, "5")).toEqual({ ok: true });
    await app.runScheduled();
    expect(await frozenNights()).toEqual(["Friday 2026-11-03 2 on", "Solo 2026-11-03 1 off"]);
  });

  it("freezes Never on for a Group whose Yes count never reached the threshold", async () => {
    const { app, ids, answer } = await setUp();
    await answer(ids.alice, "yes");
    await answer(ids.bob, "no");

    app.clock.set(RESET_4_NOV);
    await app.runScheduled();

    expect(await frozenNights()).toContain("Friday 2026-11-03 3 never");
  });

  it("changes nothing on a second run for the same Game Night, or on overlapping runs", async () => {
    const { app, ids, answer } = await setUp();
    await answer(ids.alice, "yes");
    app.clock.set(RESET_4_NOV);

    await Promise.all([app.runScheduled(), app.runScheduled()]);
    const nights = await frozenNights();
    const rows = await frozenRows();
    expect(nights).toHaveLength(2);
    expect(rows).toHaveLength(3);

    await app.runScheduled();
    // Running the same Reset with a stale view of scheduler_state, as an
    // overlapping run would, adds nothing either.
    await env.DB.prepare("UPDATE scheduler_state SET last_reset_game_night = '2026-11-03'").run();
    await createHistory({ env, clock: app.clock }).reset();

    expect(await frozenNights()).toEqual(nights);
    expect(await frozenRows()).toEqual(rows);
    expect(await storedNight()).toBe("2026-11-04");
  });

  it("never moves the stored night backwards", async () => {
    const { app } = await setUp();
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-11-10')").run();
    app.clock.set(RESET_4_NOV);

    expect(await createHistory({ env, clock: app.clock }).reset()).toEqual([]);
    expect(await storedNight()).toBe("2026-11-10");
    expect(await frozenNights()).toEqual([]);
  });

  it("catches up every missed night oldest first, 30 per run, the rest at the next run", async () => {
    const { app, ids, invites, answer } = await setUp("2026-09-01T12:00:00Z");
    // Dan joins Friday during Game Night 2026-10-15, after the night before it ended.
    await app.createLogin({ username: "Dan", password: PASSWORD });
    app.clock.set("2026-10-15T12:00:00Z");
    const fridayId = (await env.DB.prepare("SELECT id FROM groups WHERE name = 'Friday'").first<{ id: number }>())!.id;
    const made = await invites.makeInvite(ids.alice, fridayId, "");
    if (!made.ok) throw new Error("makeInvite failed");
    await invites.joinWithInvite(await memberId("Dan"), made.token);
    await answer(ids.alice, "yes");
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-10-01')").run();

    app.clock.set("2026-11-04T03:00:00Z");
    const history = createHistory({ env, clock: app.clock });
    const first = await history.reset();
    expect(first).toHaveLength(30);
    expect(first[0]).toBe("2026-10-01");
    expect(first.at(-1)).toBe("2026-10-30");
    expect(await storedNight()).toBe("2026-10-31");
    expect(await frozenNights()).toHaveLength(60);

    expect(await history.reset()).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(await storedNight()).toBe("2026-11-04");
    expect(await frozenNights()).toHaveLength(68);
    expect(await history.reset()).toEqual([]);

    const rows = await frozenRows();
    expect(rows).toContain("Friday 2026-10-15 Alice yes -");
    expect(rows).toContain("Friday 2026-10-14 Alice - -");
    // Dan has no row for nights that ended before he joined.
    expect(rows).not.toContain("Friday 2026-10-14 Dan - -");
    expect(rows).toContain("Friday 2026-10-15 Dan - -");
    expect(rows.filter((row) => row.includes(" Dan "))).toHaveLength(20);
  });

  it("freezes only the night just ended on the first Reset ever", async () => {
    const { app } = await setUp("2026-09-01T12:00:00Z");
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();

    expect(await frozenNights()).toEqual(["Friday 2026-11-03 3 never", "Solo 2026-11-03 3 never"]);
  });

  it("leaves out a Member who joined, and a Group created, after the night ended", async () => {
    const { app, ids, invites, groups, friday } = await setUp();
    await app.createLogin({ username: "Dan", password: PASSWORD });
    // Both happen after 06:00 UTC+4 on 4 Nov, before the hourly run gets to the Reset.
    app.clock.set("2026-11-04T02:00:00.001Z");
    const made = await invites.makeInvite(ids.alice, friday, "");
    if (!made.ok) throw new Error("makeInvite failed");
    await invites.joinWithInvite(await memberId("Dan"), made.token);
    await groups.createGroup(ids.carol, "Late");
    app.clock.set("2026-11-04T02:30:00Z");
    await app.runScheduled();

    expect(await frozenNights()).toEqual(["Friday 2026-11-03 3 never", "Solo 2026-11-03 3 never"]);
    expect((await frozenRows()).filter((row) => row.includes("Dan"))).toEqual([]);
  });

  it("empties tonight's Boards, and Check-ins after 06:00 UTC+4 count for the new night", async () => {
    const { app, alice, ids, answer, friday } = await setUp();
    await answer(ids.alice, "yes");

    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    const tonight = await (await alice.get("/")).text();
    expect(tonight).not.toContain('class="board-row" data-availability="yes"');
    expect(tonight).toContain('class="board-row" data-availability="none"');
    expect(tonight).toContain("No answer yet");

    expect((await alice.post("/?index", { intent: "availability", groupId: String(friday), availability: "no" })).status).toBe(303);
    app.clock.set("2026-11-05T02:00:00Z");
    await app.runScheduled();

    expect(await frozenRows()).toEqual(
      expect.arrayContaining(["Friday 2026-11-03 Alice yes -", "Friday 2026-11-04 Alice no -"]),
    );
  });

  it("does nothing at the other hours of a Game Night", async () => {
    const { app, ids, answer } = await setUp();
    app.clock.set(RESET_4_NOV);
    await app.runScheduled();
    const nights = await frozenNights();
    const rows = await frozenRows();

    await answer(ids.alice, "yes");
    for (const hour of ["03", "12", "23"]) {
      app.clock.set(`2026-11-04T${hour}:00:00Z`);
      expect(await createHistory({ env, clock: app.clock }).reset()).toEqual([]);
    }
    app.clock.set("2026-11-05T01:59:59.999Z");
    await app.runScheduled();

    expect(await frozenNights()).toEqual(nights);
    expect(await frozenRows()).toEqual(rows);
    expect(await storedNight()).toBe("2026-11-04");
  });
});
