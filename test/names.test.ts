import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuth, type CurrentMember } from "~/auth/auth";
import { displayNameError, nameKey, shownName, usernameKey } from "~/auth/rules";

import { startApp } from "./harness";

const PASSWORD = "correct horse battery";
const IP = "203.0.113.7";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Creates the logins and returns the Auth module and each login's session Member. */
async function setup(...usernames: string[]) {
  const app = startApp();
  const auth = createAuth({ env, clock: app.clock });
  const members: CurrentMember[] = [];
  for (const username of usernames) {
    await app.createLogin({ username, password: PASSWORD });
    const token = (await auth.logIn(username, PASSWORD, IP)) ?? "";
    const member = await auth.resolveSession(token);
    if (!member) throw new Error("no session");
    members.push(member);
  }
  return { app, auth, members };
}

async function nameKeys(): Promise<[string, number][]> {
  const { results } = await env.DB.prepare("SELECT name_key, member_id FROM name_keys ORDER BY name_key").all<{
    name_key: string;
    member_id: number;
  }>();
  return results.map((row) => [row.name_key, row.member_id]);
}

async function memberRow(id: number) {
  return env.DB.prepare("SELECT username, username_lower, display_name, colour FROM members WHERE id = ?1")
    .bind(id)
    .first();
}

describe("migration 0009", () => {
  it("backfills a name_keys row for every Member created before it", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 8));
    await env.DB.prepare(
      `INSERT INTO members (username, username_lower, colour, password_hash, password_salt, password_iterations, created_at)
       VALUES ('Old Timer', 'old timer', 'slate', ?1, ?2, 1000, '2026-01-01T00:00:00.000Z')`,
    )
      .bind("0".repeat(64), "0".repeat(32))
      .run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const row = await env.DB.prepare("SELECT id, display_name FROM members").first<{ id: number; display_name: null }>();
    expect(row?.display_name).toBeNull();
    expect(await nameKeys()).toEqual([["old timer", row?.id]]);
  });
});

describe("name rules", () => {
  it("shares one key function between usernames and Display Names", () => {
    expect(nameKey("  Dark Knight ")).toBe("dark knight");
    expect(usernameKey("  Dark Knight ")).toBe(nameKey("  Dark Knight "));
  });

  it("accepts a Display Name of 1 to 32 code points, emoji included", () => {
    expect(displayNameError("A")).toBeNull();
    expect(displayNameError("🎲")).toBeNull();
    expect(displayNameError("🎮".repeat(32))).toBeNull();
    expect(displayNameError("é".repeat(33))).toBe("Use 1 to 32 characters.");
    expect(displayNameError("")).toBe("Use 1 to 32 characters.");
  });

  it("accepts joined emoji, skin tones and tag flags", () => {
    expect(displayNameError("👨‍👩‍👧")).toBeNull(); // U+200D between emoji
    expect(displayNameError("🏳️‍🌈 Pride")).toBeNull(); // U+FE0F before the joiner
    expect(displayNameError("👩🏽‍💻")).toBeNull(); // skin tone before the joiner
    expect(displayNameError("🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}")).toBeNull(); // Scotland
  });

  it("refuses a joiner or tag outside an emoji sequence", () => {
    expect(displayNameError("Ali‍ce")).toContain("invisible characters");
    expect(displayNameError("🎲‍")).toContain("invisible characters");
    expect(displayNameError("‍🎲")).toContain("invisible characters");
    expect(displayNameError("ab\u{E0067}\u{E007F}")).toContain("invisible characters");
    expect(displayNameError("Ali​ce")).toContain("invisible characters");
    expect(displayNameError("Ali\tce")).toContain("invisible characters");
  });

  it("shows the Display Name when set, else the username", () => {
    expect(shownName({ username: "alice", displayName: "Ace 🎯" })).toBe("Ace 🎯");
    expect(shownName({ username: "alice", displayName: null })).toBe("alice");
  });
});

describe("createLogin and name_keys", () => {
  it("inserts the username key with the login", async () => {
    const { members } = await setup("Alice");

    expect(await nameKeys()).toEqual([["alice", members[0].id]]);
  });

  it("refuses a username equal to another Member's Display Name, in any case", async () => {
    const { app, auth, members } = await setup("Alice");
    expect(await auth.saveProfileNames(members[0], { username: "Alice", displayName: "Ace", colour: "blue" })).toEqual({
      ok: true,
    });
    const token = await app.issueSetupLink("second");

    const taken = await (await app.deviceWithLink(`/setup/${token}`)).post("/setup", {
      username: "ACE",
      password: PASSWORD,
      colour: "blue",
    });

    expect(taken.status).toBe(400);
    expect(await taken.text()).toContain("That username is taken.");
    expect(await nameKeys()).toEqual([
      ["ace", members[0].id],
      ["alice", members[0].id],
    ]);
  });
});

describe("saveProfileNames", () => {
  it("saves a Display Name and colour and the session Member carries them", async () => {
    const { auth, members } = await setup("Alice");
    const [alice] = members;

    expect(await auth.saveProfileNames(alice, { username: "Alice", displayName: "Ace 🎯", colour: "pink" })).toEqual({
      ok: true,
    });

    expect(await memberRow(alice.id)).toEqual({
      username: "Alice",
      username_lower: "alice",
      display_name: "Ace 🎯",
      colour: "pink",
    });
    expect(await nameKeys()).toEqual([
      ["ace 🎯", alice.id],
      ["alice", alice.id],
    ]);
    const token = (await auth.logIn("alice", PASSWORD, IP)) ?? "";
    expect(await auth.resolveSession(token)).toEqual({
      id: alice.id,
      username: "Alice",
      displayName: "Ace 🎯",
      colour: "pink",
    });
  });

  it("allows the Member's own username as their Display Name, holding one key", async () => {
    const { auth, members } = await setup("Alice");

    expect(await auth.saveProfileNames(members[0], { username: "Alice", displayName: "ALICE", colour: "blue" })).toEqual({
      ok: true,
    });

    expect(await nameKeys()).toEqual([["alice", members[0].id]]);
    expect((await memberRow(members[0].id))?.display_name).toBe("ALICE");
  });

  it("refuses a Display Name equal to another Member's username or Display Name, ignoring case", async () => {
    const { auth, members } = await setup("Alice", "Bob");
    const [alice, bob] = members;
    await auth.saveProfileNames(bob, { username: "Bob", displayName: "Bobby", colour: "blue" });

    const asUsername = await auth.saveProfileNames(alice, { username: "Alice", displayName: "BOB", colour: "blue" });
    const asDisplayName = await auth.saveProfileNames(alice, { username: "Alice", displayName: "bobby", colour: "blue" });

    expect(asUsername).toEqual({ ok: false, errors: { displayName: "That name is taken." } });
    expect(asDisplayName).toEqual({ ok: false, errors: { displayName: "That name is taken." } });
  });

  it("refuses a username equal to another Member's Display Name", async () => {
    const { auth, members } = await setup("Alice", "Bob");
    const [alice, bob] = members;
    await auth.saveProfileNames(bob, { username: "Bob", displayName: "Bobby", colour: "blue" });

    expect(await auth.saveProfileNames(alice, { username: "Bobby", displayName: null, colour: "blue" })).toEqual({
      ok: false,
      errors: { username: "That username is taken." },
    });
  });

  it("changes nothing when the batch is refused", async () => {
    const { auth, members } = await setup("Alice", "Bob");
    const [alice] = members;
    const keysBefore = await nameKeys();
    const rowBefore = await memberRow(alice.id);

    const result = await auth.saveProfileNames(alice, { username: "Alicia", displayName: "bob", colour: "pink" });

    expect(result).toEqual({ ok: false, errors: { displayName: "That name is taken." } });
    expect(await nameKeys()).toEqual(keysBefore);
    expect(await memberRow(alice.id)).toEqual(rowBefore);
  });

  it("frees the Display Name's key when it is cleared", async () => {
    const { auth, members } = await setup("Alice", "Bob");
    const [alice, bob] = members;
    await auth.saveProfileNames(alice, { username: "Alice", displayName: "Ace", colour: "blue" });

    expect(await auth.saveProfileNames(alice, { username: "Alice", displayName: null, colour: "blue" })).toEqual({
      ok: true,
    });
    expect((await memberRow(alice.id))?.display_name).toBeNull();
    expect(await auth.saveProfileNames(bob, { username: "Ace", displayName: null, colour: "blue" })).toEqual({
      ok: true,
    });
  });

  it("frees the old username on a rename, and logs in with the new one only", async () => {
    const { auth, members } = await setup("Alice", "Bob");
    const [alice, bob] = members;

    expect(await auth.saveProfileNames(alice, { username: "Alicia", displayName: null, colour: "blue" })).toEqual({
      ok: true,
    });

    expect(await auth.logIn("alicia", PASSWORD, IP)).not.toBeNull();
    expect(await auth.logIn("alice", PASSWORD, IP)).toBeNull();
    expect(await auth.saveProfileNames(bob, { username: "Bob", displayName: "Alice", colour: "blue" })).toEqual({
      ok: true,
    });
  });

  it("allows a case-only username change", async () => {
    const { auth, members } = await setup("alice");

    expect(await auth.saveProfileNames(members[0], { username: "ALICE", displayName: null, colour: "blue" })).toEqual({
      ok: true,
    });
    expect(await memberRow(members[0].id)).toMatchObject({ username: "ALICE", username_lower: "alice" });
  });

  it("refuses a new username equal to the password as typed", async () => {
    const { auth, members } = await setup("Alice");

    expect(await auth.saveProfileNames(members[0], { username: PASSWORD, displayName: null, colour: "blue" })).toEqual({
      ok: false,
      errors: { username: "Choose a username that is not your password." },
    });
    expect((await memberRow(members[0].id))?.username).toBe("Alice");
  });

  it("runs PBKDF2 once when the username changes and never when it stays", async () => {
    const { auth, members } = await setup("Alice");
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");

    await auth.saveProfileNames(members[0], { username: "Alice", displayName: "Ace", colour: "pink" });
    expect(deriveBits).toHaveBeenCalledTimes(0);

    await auth.saveProfileNames(members[0], { username: "Alicia", displayName: "Ace", colour: "pink" });
    expect(deriveBits).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two racing saves take the same name", async () => {
    const { auth, members } = await setup("Alice", "Bob");
    const [alice, bob] = members;

    const results = await Promise.all([
      auth.saveProfileNames(alice, { username: "Alice", displayName: "Ace", colour: "blue" }),
      auth.saveProfileNames(bob, { username: "Bob", displayName: "ace", colour: "blue" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await nameKeys()).filter(([key]) => key === "ace")).toHaveLength(1);
  });
});
