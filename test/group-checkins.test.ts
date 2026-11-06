import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createCheckins } from "~/checkins";

import { fixedClock } from "./harness";

const NOON = "2026-11-03T12:00:00.000Z";

/** Every group_checkins row, in a stable order. */
async function groupCheckins() {
  const { results } = await env.DB.prepare(
    `SELECT group_id, member_id, game_night, availability, note, said_yes_notified, updated_at
     FROM group_checkins ORDER BY game_night, group_id, member_id`,
  ).all();
  return results;
}

/** Inserts a Member directly in D1 and returns its id. */
async function seedMember(username: string): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO members (username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
     VALUES (?1, lower(?1), 'blue', 'aa', 'bb', 1, ?2) RETURNING id`,
  )
    .bind(username, NOON)
    .first<{ id: number }>();
  return row!.id;
}

/** Inserts a Group owned by `ownerId` with the given Members and returns its id. */
async function seedGroup(name: string, ownerId: number, memberIds: number[], threshold = 3): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO groups (name, owner_id, threshold, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id",
  )
    .bind(name, ownerId, threshold, NOON)
    .first<{ id: number }>();
  for (const memberId of memberIds) {
    await env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, ?3)")
      .bind(row!.id, memberId, NOON)
      .run();
  }
  return row!.id;
}

describe("migration 0011", () => {
  /** Rebuilds the schema up to 0010, so a test can seed the old checkins table before 0011 runs. */
  async function beforeMigration() {
    await reset();
    const migrations = env.TEST_MIGRATIONS;
    const index = migrations.findIndex((migration) => migration.name.startsWith("0011"));
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, migrations.slice(0, index));
    return () => applyD1Migrations(env.DB, migrations);
  }

  it("copies each unfrozen Check-in into every Group of its Member, and leaves frozen nights and checkins alone", async () => {
    const migrate = await beforeMigration();
    const alice = await seedMember("Alice");
    const bob = await seedMember("Bob");
    const friday = await seedGroup("Friday", alice, [alice, bob]);
    const sunday = await seedGroup("Sunday", alice, [alice]);
    // The Reset froze the night of 2026-11-02; 2026-11-03 is tonight.
    await env.DB.prepare("INSERT INTO scheduler_state (id, last_reset_game_night) VALUES (1, '2026-11-03')").run();
    const checkin = env.DB.prepare(
      `INSERT INTO checkins (member_id, game_night, availability, note, updated_at, said_yes_notified)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    );
    await env.DB.batch([
      checkin.bind(alice, "2026-11-02", "no", "frozen", "2026-11-02T12:00:00.000Z", 0),
      checkin.bind(alice, "2026-11-03", "yes", "on after 10", "2026-11-03T11:00:00.000Z", 1),
      checkin.bind(bob, "2026-11-03", "maybe", null, "2026-11-03T11:30:00.000Z", 0),
    ]);
    const { results: before } = await env.DB.prepare("SELECT * FROM checkins ORDER BY member_id, game_night").all();

    await migrate();

    expect(await groupCheckins()).toEqual([
      {
        group_id: friday,
        member_id: alice,
        game_night: "2026-11-03",
        availability: "yes",
        note: "on after 10",
        said_yes_notified: 1,
        updated_at: "2026-11-03T11:00:00.000Z",
      },
      {
        group_id: friday,
        member_id: bob,
        game_night: "2026-11-03",
        availability: "maybe",
        note: null,
        said_yes_notified: 0,
        updated_at: "2026-11-03T11:30:00.000Z",
      },
      {
        group_id: sunday,
        member_id: alice,
        game_night: "2026-11-03",
        availability: "yes",
        note: "on after 10",
        said_yes_notified: 1,
        updated_at: "2026-11-03T11:00:00.000Z",
      },
    ]);
    const { results: after } = await env.DB.prepare("SELECT * FROM checkins ORDER BY member_id, game_night").all();
    expect(after).toEqual(before);
  });

  it("copies every night when the Reset has never run", async () => {
    const migrate = await beforeMigration();
    const alice = await seedMember("Alice");
    const friday = await seedGroup("Friday", alice, [alice]);
    await env.DB.prepare(
      "INSERT INTO checkins (member_id, game_night, availability, updated_at) VALUES (?1, '2026-11-03', 'no', ?2)",
    )
      .bind(alice, NOON)
      .run();

    await migrate();

    expect(await groupCheckins()).toEqual([expect.objectContaining({ group_id: friday, member_id: alice, availability: "no" })]);
  });

  it("refuses an Availability other than yes, maybe or no", async () => {
    const alice = await seedMember("Alice");
    const friday = await seedGroup("Friday", alice, [alice]);
    const insert = env.DB.prepare(
      "INSERT INTO group_checkins (group_id, member_id, game_night, availability, updated_at) VALUES (?1, ?2, '2026-11-03', ?3, ?4)",
    );
    await expect(insert.bind(friday, alice, "later", NOON).run()).rejects.toThrow(/CHECK/);
    await expect(insert.bind(friday, alice, "yes", NOON).run()).resolves.toBeDefined();
  });

  it("removes a Group's or a login's Check-ins with it, and keeps them when a Member leaves", async () => {
    const alice = await seedMember("Alice");
    const bob = await seedMember("Bob");
    const friday = await seedGroup("Friday", alice, [alice, bob]);
    const sunday = await seedGroup("Sunday", alice, [alice, bob]);
    const checkins = createCheckins({ env, clock: fixedClock(NOON) });
    for (const groupId of [friday, sunday]) {
      await checkins.setAvailability(alice, groupId, "yes");
      await checkins.setAvailability(bob, groupId, "no");
    }

    await env.DB.prepare("DELETE FROM memberships WHERE group_id = ?1 AND member_id = ?2").bind(sunday, bob).run();
    expect(await groupCheckins()).toHaveLength(4);

    await env.DB.prepare("DELETE FROM groups WHERE id = ?1").bind(friday).run();
    expect((await groupCheckins()).map((row) => [row.group_id, row.member_id])).toEqual([
      [sunday, alice],
      [sunday, bob],
    ]);

    await env.DB.prepare("DELETE FROM members WHERE id = ?1").bind(bob).run();
    expect((await groupCheckins()).map((row) => [row.group_id, row.member_id])).toEqual([[sunday, alice]]);
  });
});

describe("Check-ins per Group", () => {
  /** Alice and Bob in Friday and Sunday, both with a threshold of 2, and the Check-ins on noon of 2026-11-03. */
  async function twoGroups() {
    const alice = await seedMember("Alice");
    const bob = await seedMember("Bob");
    const friday = await seedGroup("Friday", alice, [alice, bob], 2);
    const sunday = await seedGroup("Sunday", alice, [alice, bob], 2);
    const checkins = createCheckins({ env, clock: fixedClock(NOON) });
    const board = async (memberId: number, groupId: number) =>
      (await checkins.tonightFor(memberId)).boards.find((b) => b.groupId === groupId)!;
    return { alice, bob, friday, sunday, checkins, board };
  }

  it("keeps a Yes in one Group and a No in another apart, and moves only the Yes Group's count", async () => {
    const { alice, bob, friday, sunday, checkins, board } = await twoGroups();
    expect(await checkins.setAvailability(alice, friday, "yes")).toEqual({ ok: true });
    expect(await checkins.setAvailability(alice, sunday, "no")).toEqual({ ok: true });

    expect(await board(alice, friday)).toMatchObject({ yes: 1, own: { availability: "yes", note: null } });
    expect(await board(alice, sunday)).toMatchObject({ yes: 0, own: { availability: "no", note: null } });
    expect((await board(bob, friday)).rows.find((row) => row.memberId === alice)?.availability).toBe("yes");
    expect((await board(bob, sunday)).rows.find((row) => row.memberId === alice)?.availability).toBe("no");
    expect((await board(bob, friday)).own).toBeNull();
  });

  it("writes nothing for a Group the Member is not in", async () => {
    const { alice, checkins } = await twoGroups();
    const carol = await seedMember("Carol");
    const carols = await seedGroup("Carol's", carol, [carol], 1);

    expect(await checkins.setAvailability(alice, carols, "yes")).toEqual({ ok: false, notMember: true });
    expect(await checkins.setNote(alice, carols, "hi")).toEqual({ ok: false, notMember: true });
    expect(await checkins.setAvailability(alice, 9999, "yes")).toEqual({ ok: false, notMember: true });
    expect(await groupCheckins()).toEqual([]);
    const { results } = await env.DB.prepare("SELECT * FROM group_night_state").all();
    expect(results).toEqual([]);
  });

  it("writes nothing once the Member has left, and finds the earlier answer again on rejoining", async () => {
    const { alice, bob, friday, checkins } = await twoGroups();
    await checkins.setAvailability(bob, friday, "maybe");
    await env.DB.prepare("DELETE FROM memberships WHERE group_id = ?1 AND member_id = ?2").bind(friday, bob).run();

    expect(await checkins.setAvailability(bob, friday, "yes")).toEqual({ ok: false, notMember: true });
    expect(await checkins.setNote(bob, friday, "late")).toEqual({ ok: false, notMember: true });
    expect(await groupCheckins()).toEqual([expect.objectContaining({ member_id: bob, availability: "maybe", note: null })]);

    await env.DB.prepare("INSERT INTO memberships (group_id, member_id, joined_at) VALUES (?1, ?2, ?3)")
      .bind(friday, bob, NOON)
      .run();
    const rejoined = (await checkins.tonightFor(alice)).boards.find((b) => b.groupId === friday)!;
    expect(rejoined.rows.find((row) => row.memberId === bob)?.availability).toBe("maybe");
  });

  it("keeps one Note per Group and asks for an answer first in each Group", async () => {
    const { alice, friday, sunday, checkins, board } = await twoGroups();
    await checkins.setAvailability(alice, friday, "yes");

    expect(await checkins.setNote(alice, sunday, "late")).toEqual({
      ok: false,
      notMember: false,
      error: "Answer Yes, Maybe or No before adding a Note.",
    });
    expect(await checkins.setNote(alice, friday, "on after 10")).toEqual({ ok: true });
    await checkins.setAvailability(alice, sunday, "maybe");
    expect(await checkins.setNote(alice, sunday, "maybe late")).toEqual({ ok: true });

    expect((await board(alice, friday)).own).toEqual({ availability: "yes", note: "on after 10" });
    expect((await board(alice, sunday)).own).toEqual({ availability: "maybe", note: "maybe late" });
    // Changing the answer in one Group keeps both Notes.
    await checkins.setAvailability(alice, friday, "no");
    expect((await board(alice, friday)).own).toEqual({ availability: "no", note: "on after 10" });
    expect((await board(alice, sunday)).own).toEqual({ availability: "maybe", note: "maybe late" });
  });

  it("crosses Game On and Game Off in one Group and leaves the other untouched", async () => {
    const { alice, bob, friday, sunday, checkins, board } = await twoGroups();
    await checkins.setAvailability(alice, friday, "yes");
    await checkins.setAvailability(alice, sunday, "yes");
    await checkins.setAvailability(bob, friday, "yes");
    await checkins.setAvailability(bob, sunday, "no");

    expect((await board(alice, friday)).pill.text).toBe("Game On");
    expect((await board(alice, sunday)).pill.text).toBe("Needs 1 more Yes");

    await checkins.setAvailability(bob, friday, "no");
    expect((await board(alice, friday)).pill.text).toBe("Game Off");
    expect((await board(alice, sunday)).pill.text).toBe("Needs 1 more Yes");
    const { results } = await env.DB.prepare("SELECT group_id, was_on FROM group_night_state").all();
    expect(results).toEqual([{ group_id: friday, was_on: 1 }]);
  });
});
