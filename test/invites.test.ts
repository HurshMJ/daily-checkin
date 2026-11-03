import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { hashToken } from "~/auth/crypto";
import { createCheckins } from "~/checkins";
import { createInvites, inviteLabelError, normaliseInviteLabel } from "~/invites";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";

async function idOf(table: "members" | "groups", column: "username" | "name", value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${column} = ?1`).bind(value).first<{ id: number }>();
  return row!.id;
}

async function invites() {
  const { results } = await env.DB.prepare(
    "SELECT id, token_hash, group_id, created_by, label, created_at, used_at, cancelled_at FROM invites ORDER BY id",
  ).all<Record<string, unknown>>();
  return results;
}

async function membersOf(groupId: number): Promise<number[]> {
  const { results } = await env.DB.prepare("SELECT member_id FROM memberships WHERE group_id = ?1 ORDER BY member_id")
    .bind(groupId)
    .all<{ member_id: number }>();
  return results.map((row) => row.member_id);
}

/** Alice owns "Friday"; Bob and Carol have logins and no Group. */
async function setUp() {
  const app = startApp();
  const alice = await app.createLogin({ username: "Alice", password: PASSWORD });
  await alice.post("/groups/new", { name: "Friday" });
  const bob = await app.createLogin({ username: "Bob", password: PASSWORD });
  await app.createLogin({ username: "Carol", password: PASSWORD });
  const context = { env, clock: app.clock };
  return {
    app,
    alice,
    bob,
    invites: createInvites(context),
    checkins: createCheckins(context),
    ids: {
      alice: await idOf("members", "username", "Alice"),
      bob: await idOf("members", "username", "Bob"),
      carol: await idOf("members", "username", "Carol"),
      friday: await idOf("groups", "name", "Friday"),
    },
  };
}

describe("migration 0005", () => {
  it("adds the invites table with a unique token hash", async () => {
    const columns = await env.DB.prepare("SELECT name FROM pragma_table_info('invites') ORDER BY cid").all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toEqual([
      "id",
      "token_hash",
      "group_id",
      "created_by",
      "label",
      "created_at",
      "used_at",
      "cancelled_at",
    ]);
    const { ids } = await setUp();
    const insert = () =>
      env.DB.prepare("INSERT INTO invites (token_hash, group_id, created_at) VALUES ('x', ?1, '2026-11-03T12:00:00.000Z')")
        .bind(ids.friday)
        .run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE constraint failed: invites.token_hash/);
  });
});

describe("Invite label rule", () => {
  it("stores a blank label as no label and trims the rest", () => {
    expect(normaliseInviteLabel("   ")).toBeNull();
    expect(normaliseInviteLabel("  for Sam ")).toBe("for Sam");
    expect(inviteLabelError(null)).toBeNull();
  });

  it("accepts 40 code points, emoji included, and refuses 41", () => {
    expect(inviteLabelError(normaliseInviteLabel("🎲".repeat(40)))).toBeNull();
    expect(inviteLabelError(normaliseInviteLabel("🎲".repeat(41)))).toBe("Use at most 40 characters.");
  });

  it("refuses control and invisible characters", () => {
    expect(inviteLabelError(normaliseInviteLabel("for\tSam"))).toBe("Remove tabs, line breaks and invisible characters.");
    expect(inviteLabelError(normaliseInviteLabel("for​Sam"))).toBe(
      "Remove tabs, line breaks and invisible characters.",
    );
  });
});

describe("making, listing and cancelling Invites", () => {
  it("stores only the token's hash, the label and who made it", async () => {
    const { invites: inv, ids } = await setUp();
    const made = await inv.makeInvite(ids.alice, ids.friday, "  for Sam ");
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const rows = await invites();
    expect(rows).toEqual([
      {
        id: expect.any(Number),
        token_hash: await hashToken(made.token),
        group_id: ids.friday,
        created_by: ids.alice,
        label: "for Sam",
        created_at: "2026-11-03T12:00:00.000Z",
        used_at: null,
        cancelled_at: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(made.token);
  });

  it("stores a blank label as NULL and refuses a bad one with its message", async () => {
    const { invites: inv, ids } = await setUp();
    expect((await inv.makeInvite(ids.alice, ids.friday, " ")).ok).toBe(true);
    expect(await inv.makeInvite(ids.alice, ids.friday, "x".repeat(41))).toEqual({
      ok: false,
      reason: "label",
      error: "Use at most 40 characters.",
      label: "x".repeat(41),
    });
    expect(await inv.makeInvite(ids.alice, ids.friday, "a​b")).toMatchObject({
      ok: false,
      error: "Remove tabs, line breaks and invisible characters.",
    });
    expect((await invites()).map((row) => row.label)).toEqual([null]);
  });

  it("lists pending Invites newest first and leaves out used and cancelled ones", async () => {
    const { app, invites: inv, ids } = await setUp();
    await inv.makeInvite(ids.alice, ids.friday, "first");
    app.clock.set("2026-11-03T12:05:00Z");
    const used = await inv.makeInvite(ids.alice, ids.friday, "used");
    app.clock.set("2026-11-03T12:10:00Z");
    await inv.makeInvite(ids.alice, ids.friday, "");
    app.clock.set("2026-11-03T12:15:00Z");
    await inv.makeInvite(ids.alice, ids.friday, "cancelled");
    if (!used.ok) throw new Error("make failed");
    await inv.joinWithInvite(ids.bob, used.token);
    const cancelled = (await invites()).find((row) => row.label === "cancelled")!;
    await inv.cancelInvite(ids.alice, ids.friday, cancelled.id as number);

    const pending = await inv.pendingInvites(ids.alice, ids.friday);
    expect(pending?.map((invite) => [invite.label, invite.createdAt])).toEqual([
      [null, "2026-11-03T12:10:00.000Z"],
      ["first", "2026-11-03T12:00:00.000Z"],
    ]);
  });

  it("lets only the Owner make, list or cancel", async () => {
    const { invites: inv, ids } = await setUp();
    const made = await inv.makeInvite(ids.alice, ids.friday, "for Sam");
    if (!made.ok) throw new Error("make failed");
    await inv.joinWithInvite(ids.bob, made.token);
    const second = await inv.makeInvite(ids.alice, ids.friday, "");
    if (!second.ok) throw new Error("make failed");
    const pendingId = (await inv.pendingInvites(ids.alice, ids.friday))![0].id;

    // Bob is now a Member, not the Owner.
    expect(await inv.makeInvite(ids.bob, ids.friday, "")).toEqual({ ok: false, reason: "not-owner" });
    expect(await inv.pendingInvites(ids.bob, ids.friday)).toBeNull();
    expect(await inv.cancelInvite(ids.bob, ids.friday, pendingId)).toEqual({ ok: false, reason: "not-owner" });
    expect((await invites()).map((row) => row.cancelled_at)).toEqual([null, null]);
  });

  it("cancels a pending Invite once, and never a used one or one of another Group", async () => {
    const { alice, invites: inv, ids } = await setUp();
    await alice.post("/groups/new", { name: "Sunday" });
    const sunday = await idOf("groups", "name", "Sunday");
    const used = await inv.makeInvite(ids.alice, ids.friday, "used");
    const pending = await inv.makeInvite(ids.alice, ids.friday, "pending");
    if (!used.ok || !pending.ok) throw new Error("make failed");
    await inv.joinWithInvite(ids.bob, used.token);
    const [usedRow, pendingRow] = await invites();

    expect(await inv.cancelInvite(ids.alice, sunday, pendingRow.id as number)).toEqual({ ok: false, reason: "not-pending" });
    expect(await inv.cancelInvite(ids.alice, ids.friday, usedRow.id as number)).toEqual({ ok: false, reason: "not-pending" });
    expect(await inv.cancelInvite(ids.alice, ids.friday, pendingRow.id as number)).toEqual({ ok: true });
    expect(await inv.cancelInvite(ids.alice, ids.friday, pendingRow.id as number)).toEqual({ ok: false, reason: "not-pending" });
    expect(await inv.inviteFor(pending.token)).toEqual({ usable: false });
  });
});

describe("joining with an Invite", () => {
  it("names the Group and the inviter, and treats used, cancelled and unknown tokens alike", async () => {
    const { invites: inv, ids } = await setUp();
    const made = await inv.makeInvite(ids.alice, ids.friday, "");
    if (!made.ok) throw new Error("make failed");

    expect(await inv.inviteFor(made.token, ids.bob)).toEqual({
      usable: true,
      groupId: ids.friday,
      groupName: "Friday",
      inviterName: "Alice",
      alreadyMember: false,
    });
    expect((await inv.inviteFor(made.token, ids.alice)) as { alreadyMember: boolean }).toMatchObject({
      alreadyMember: true,
    });
    expect(await inv.inviteFor("not-a-real-token")).toEqual({ usable: false });

    expect(await inv.joinWithInvite(ids.bob, made.token)).toBe("joined");
    expect(await inv.inviteFor(made.token)).toEqual({ usable: false });
  });

  it("joins once: the second use of a token is unusable", async () => {
    const { invites: inv, ids } = await setUp();
    const made = await inv.makeInvite(ids.alice, ids.friday, "");
    if (!made.ok) throw new Error("make failed");

    expect(await inv.joinWithInvite(ids.bob, made.token)).toBe("joined");
    expect(await inv.joinWithInvite(ids.carol, made.token)).toBe("unusable");
    expect(await membersOf(ids.friday)).toEqual([ids.alice, ids.bob]);
    expect((await invites())[0].used_at).toBe("2026-11-03T12:00:00.000Z");
  });

  it("lets exactly one of two racing joins with one token in", async () => {
    const { invites: inv, ids } = await setUp();
    const made = await inv.makeInvite(ids.alice, ids.friday, "");
    if (!made.ok) throw new Error("make failed");

    const results = await Promise.all([
      inv.joinWithInvite(ids.bob, made.token),
      inv.joinWithInvite(ids.carol, made.token),
    ]);
    expect([...results].sort()).toEqual(["joined", "unusable"]);
    const members = await membersOf(ids.friday);
    expect(members).toHaveLength(2);
    expect(members[0]).toBe(ids.alice);
  });

  it("leaves the Invite unused for a Member who is already in the Group", async () => {
    const { invites: inv, ids } = await setUp();
    const made = await inv.makeInvite(ids.alice, ids.friday, "");
    if (!made.ok) throw new Error("make failed");

    expect(await inv.joinWithInvite(ids.alice, made.token)).toBe("already-member");
    expect((await invites())[0].used_at).toBeNull();
    expect(await inv.joinWithInvite(ids.bob, made.token)).toBe("joined");
  });

  it("counts a joining Member's Yes at once, so a later drop shows Game Off", async () => {
    const { alice, invites: inv, checkins, ids } = await setUp();
    await env.DB.prepare("UPDATE groups SET threshold = 2 WHERE id = ?1").bind(ids.friday).run();
    await checkins.setAvailability(ids.alice, "yes");
    await checkins.setAvailability(ids.bob, "yes");
    const made = await inv.makeInvite(ids.alice, ids.friday, "");
    if (!made.ok) throw new Error("make failed");

    expect(await inv.joinWithInvite(ids.bob, made.token)).toBe("joined");
    const state = await env.DB.prepare("SELECT was_on FROM group_night_state WHERE group_id = ?1")
      .bind(ids.friday)
      .first<{ was_on: number }>();
    expect(state?.was_on).toBe(1);
    const page = await (await alice.get("/")).text();
    expect(page).toContain('data-state="on"><p class="board-pill">Game On</p>');

    // Bob drops to Maybe: the Board says Game Off, not "Needs 1 more Yes".
    await checkins.setAvailability(ids.bob, "maybe");
    expect(await (await alice.get("/")).text()).toContain('<p class="board-pill">Game Off</p>');
  });
});
